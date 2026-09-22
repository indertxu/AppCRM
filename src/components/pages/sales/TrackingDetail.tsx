/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import DatePicker from "../../framework/DatePicker";
import TimePicker from "../../framework/TimePicker";
import Select from "../../framework/Select";
import { loadProposalTemplate, generateProposal } from "./proposalApi";
import type { ProposalData } from "./proposalGen";
import MentionInput, { type MentionPerson } from "../../framework/MentionInput";
import "../../framework/MentionInput.css";

// Convert serialized mentions "@[Name](id)" into plain "@Name".
const MEETING_KINDS: { value: MeetingKind; label: string; icon: JSX.Element }[] = [
  { value: "teams", label: "Teams", icon: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="13" height="12" rx="2"/><path d="M15 10l7-4v12l-7-4"/></svg>) },
  { value: "phone", label: "Call", icon: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>) },
  { value: "in_person", label: "In person", icon: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/></svg>) },
];

const cleanMentionsFn = (t: string) => t.replace(/@\[([^\]]+)\]\([^)]+\)/g, "@$1");
import { supabase } from "../../api/supabase";
import HandoffClientForm from "./HandoffClientForm";
import HandoffConfirmServices, { type ConfirmService, type ConfirmClient } from "./HandoffConfirmServices";
import TrackingFiles from "./TrackingFiles";
import LineCalcModal from "../../framework/LineCalcModal";
import { loadPipeline, listPipelines, type Phase, type Pipeline } from "../settings/pipelineApi";
import { myProfile, isSalesLead } from "../companies/companiesApi";
import { loadServices, calcBreakdown, discountOf, BASE_KEY, type Service, type Calculator, type CalcDiscount } from "../settings/catalogApi";
import type { Company, Contact } from "../companies/companiesApi";
import type { Product } from "../settings/catalogApi";
import type { Employee } from "./SalesPage";
import {
  setTrackingPhase, setTrackingStatus, deleteTracking, setDealCloseProb, setDealCloseDate,
  setLossReason, listLossReasons, addLossReason, updateLossReason, deleteLossReason, type LossReason,
  loadNotes, addNote, updateNote, deleteNote,
  loadTasks, addTask, toggleTask, updateTask, deleteTask,
  loadMeetings, addMeeting, updateMeeting, deleteMeeting,
  loadPhaseEvents, stampPhaseEntry, clearPhaseEventsAfter,
  loadPotentialServices, addPotentialService, updatePotentialServiceTerm, deletePotentialService,
  loadBlueprintsForServices, billableQty, type PhaseBlueprint,
  loadTrackingEmployees, setTrackingEmployees, loadTrackingOwner, setTrackingOwner,
  loadTrackingProducts, addTrackingProduct, updateTrackingProduct, removeTrackingProduct,
  setLineVersionActive, addProductVersion, addServiceVersion,
  lineTotal, lineBreakdown, unitBreakdown,
  createHandoffs, loadTrackingHandoffs, clientExistsForCompany, buildClientPrefill, buildAttachPrefill, hasClientProductsForTracking, listCatalogProducts, saveClientProducts, syncNewContactsToCompany, loadTrackingContactIds, setTrackingContacts, type Handoff,
  loadAssignees, addAssignee, removeAssignee,
  trackingPct,
  type Tracking, type TrackNote, type TrackTask, type TrackMeeting, type MeetingKind, type PhaseEvent, type PotentialService, type Assignee,
  type TrackingProduct, type TermPatch, type RevenueLineFields,
} from "./salesApi";


/**
 * Discount for one row of a line. Defined at module level: nesting it inside
 * the modal made React remount the input on every keystroke, which is why the
 * field lost focus after a single character.
 */

/**
 * One revenue line: the numbers, a receipt you can expand, and a calculator
 * button that opens everything that decides those numbers.
 */
function RevLine({ name, tag, tagClass, line, unit, minUnit, calculator, catalogBase, onRemove, onOpenCalc, money, versionIdx, versionCount, onPrev, onNext, onNewVersion }: {
  name: string;
  tag: string;
  tagClass?: string;
  line: RevenueLineFields;
  unit?: "hour" | "day" | null;
  minUnit?: number | null;
  calculator?: Calculator | null;
  catalogBase?: number;
  onRemove: () => void;
  onOpenCalc: () => void;
  money: (n: number) => string;
  versionIdx?: number;
  versionCount?: number;
  onPrev?: () => void;
  onNext?: () => void;
  onNewVersion?: (copy: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [verMenu, setVerMenu] = useState(false);
  const bd = lineBreakdown(line, calculator, catalogBase, minUnit);
  const unitWord = unit === "hour" ? "hours" : "days";
  const qty = line.quantity == null ? 1 : Number(line.quantity);
  const years = line.term_years == null ? 1 : Number(line.term_years);

  const isQtyCalc = calculator?.output_kind === "quantity";
  const summary = line.recurring
    ? `${money(bd.unitPrice)} ${line.period === "monthly" ? "per month" : "per year"} ${bd.multiplierLabel}`
    // With a duration calculator each row already carries its own days and
    // rate, so there is no single rate to quote for the line.
    : isQtyCalc
      ? `${qty} ${unitWord} across ${bd.rows.length} ${bd.rows.length === 1 ? "line" : "lines"}`
      : unit
        ? `${money(bd.unitPrice)} per ${unit} x ${qty} ${unitWord}`
        : qty === 1 ? `${money(bd.unitPrice)} one-time` : `${money(bd.unitPrice)} x ${qty}`;

  return (
    <div className={`sl-rev-item sl-rev-card ${tag === "Product" ? "is-product" : "is-service"}`}>
      <div className="sl-rev-head">
        <span className="sl-rev-ico" aria-hidden="true">
          {tag === "Product" ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><path d="M3.3 7L12 12l8.7-5M12 22V12" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></svg>
          )}
        </span>
        <div className="sl-rev-titles">
          <span className="sl-rev-name" title={name}>{name}</span>
          <span className={`sl-rev-tag ${tagClass ?? ""}`}>{tag}</span>
        </div>
        <div className="sl-rev-amountwrap">
          <b className="sl-rev-amount">{money(bd.total)}</b>
          <span className="sl-rev-sub">{summary}</span>
        </div>
      </div>

      <div className="sl-rev-toolbar">
        <div className="sl-rev-versionbar">
          {(versionCount ?? 1) > 1 && (
            <div className="sl-ver-nav">
              <button className="sl-ver-arrow" onClick={onPrev} disabled={!onPrev} aria-label="Previous version">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
              </button>
              <span className="sl-ver-label">v{(versionIdx ?? 0) + 1}<i>/{versionCount}</i></span>
              <button className="sl-ver-arrow" onClick={onNext} disabled={!onNext} aria-label="Next version">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
              </button>
            </div>
          )}
          <div className="sl-ver-newwrap">
            <button className="sl-ver-new" onClick={() => setVerMenu((v) => !v)} title="New version">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
              <span>Version</span>
            </button>
            {verMenu && (
              <>
                <div className="sl-ver-layer" onMouseDown={() => setVerMenu(false)} />
                <div className="sl-ver-menu">
                  <button onClick={() => { setVerMenu(false); onNewVersion?.(true); }}>Copy current</button>
                  <button onClick={() => { setVerMenu(false); onNewVersion?.(false); }}>Start from scratch</button>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="sl-rev-actions">
          {bd.qty !== bd.rawQty && (
            <span className="sl-rev-round" title={`Calculated ${bd.rawQty}, billed in steps of ${minUnit}`}>{bd.rawQty} → <b>{bd.qty}</b></span>
          )}
          {bd.discount > 0 && <span className="sl-rev-disc">-{money(bd.discount)}</span>}
          <button className="sl-rev-icon" onClick={onOpenCalc} title="Open calculator" aria-label="Open calculator">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="2" width="16" height="20" rx="2" /><path d="M8 6h8M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01M8 19h4" />
            </svg>
          </button>
          <button className={`sl-rev-icon ${open ? "is-on" : ""}`} onClick={() => setOpen((o) => !o)}
            title="Show breakdown" aria-expanded={open} aria-label="Show breakdown">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d={open ? "M18 15l-6-6-6 6" : "M6 9l6 6 6-6"} />
            </svg>
          </button>
          <button className="sl-rev-icon sl-rev-icon-del" onClick={onRemove} title="Remove" aria-label="Remove line">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </div>

      {open && (
        <div className="sl-rev-receipt">
          {bd.rows.map((r) => (
            <div key={r.key} className="sl-rc-row">
              <span>{r.label}{r.detail ? ` (${r.detail})` : ""}</span>
              <em>{money(r.amount)}{r.discount > 0 ? <i className="sl-rc-off"> -{money(r.discount)}</i> : null}</em>
            </div>
          ))}
          {!isQtyCalc && (
            <div className="sl-rc-row sl-rc-sub">
              <span>{unit && !line.recurring ? `Rate per ${unit}` : "Unit price"}</span><em>{money(bd.unitPrice)}</em>
            </div>
          )}
          {line.recurring ? (
            <>
              {line.period === "monthly" && (
                <div className="sl-rc-row"><span>x 12 months</span><em>{money(bd.unitPrice * 12)}</em></div>
              )}
              <div className="sl-rc-row"><span>x {years} {years === 1 ? "year" : "years"}</span><em>{money(bd.total)}</em></div>
            </>
          ) : bd.multiplierLabel ? (
            <>
              {bd.qty !== bd.rawQty && (
                <div className="sl-rc-row sl-rc-round">
                  <span>Calculated {bd.rawQty} {unit ? unitWord : "units"}, billed in steps of {minUnit}</span>
                  <em>{bd.qty}</em>
                </div>
              )}
              <div className="sl-rc-row"><span>x {bd.qty} {unit ? unitWord : "units"}</span><em>{money(bd.total)}</em></div>
            </>
          ) : null}
          <div className="sl-rc-row sl-rc-total"><span>Total</span><em>{money(bd.total)}</em></div>
        </div>
      )}
    </div>
  );
}

export default function TrackingDetail({ tracking, companies, contacts, products, employees, onBack }: {
  tracking: Tracking; companies: Company[]; contacts: Contact[]; products: Product[]; employees: Employee[]; onBack: () => void;
}) {
  const [phases, setPhases] = useState<Phase[]>([]);
  const [allPhases, setAllPhases] = useState<Phase[]>([]);
  const [curPhase, setCurPhase] = useState<string | null>(tracking.current_phase_id);
  const [status, setStatus] = useState(tracking.status);
  const [notes, setNotes] = useState<TrackNote[]>([]);
  const [tasks, setTasks] = useState<TrackTask[]>([]);
  const [meetings, setMeetings] = useState<TrackMeeting[]>([]);
  const [itemsModal, setItemsModal] = useState<null | "notes" | "tasks" | "meetings">(null);
  const [confirmDlg, setConfirmDlg] = useState<null | { title: string; message: string; confirmLabel?: string; onConfirm: () => void }>(null);
  const ask = (opts: { title: string; message: string; confirmLabel?: string; onConfirm: () => void }) => setConfirmDlg(opts);
  const [events, setEvents] = useState<PhaseEvent[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [potentials, setPotentials] = useState<PotentialService[]>([]);
  const [tprods, setTProds] = useState<TrackingProduct[]>([]);
  const [calcFor, setCalcFor] = useState<{ kind: "product" | "service"; id: string } | null>(null);
  const [revErr, setRevErr] = useState<string | null>(null);
  const [allPipelines, setAllPipelines] = useState<Pipeline[]>([]);
  const [team, setTeam] = useState<string[]>([]);
  const [owner, setOwner] = useState<string | null>(null);
  const [me, setMe] = useState<{ id: string; role: string; is_superadmin: boolean } | null>(null);
  const [handoffMenu, setHandoffMenu] = useState(false);
  const [teamMenu, setTeamMenu] = useState(false);
  const [lossModal, setLossModal] = useState(false);
  const [lossReasons, setLossReasons] = useState<LossReason[]>([]);
  const [lossReason, setLossReasonState] = useState<string>(tracking.loss_reason ?? "");
  const [lossDetails, setLossDetails] = useState<string>(tracking.loss_details ?? "");
  useEffect(() => { listLossReasons().then(setLossReasons).catch(() => {}); }, []);
  const [handoffPicked, setHandoffPicked] = useState<Set<string>>(new Set());
  const [handoffSent, setHandoffSent] = useState(false);
  // Deferred handoff: when the client has to be created first, we stash the
  // destinations here and fire the handoff once the client form is saved.
  const [pendingHandoff, setPendingHandoff] = useState<{ id: string; name: string; services: any[]; potential_value: number }[] | null>(null);
  const [clientFormOpen, setClientFormOpen] = useState(false);
  const [clientPrefill, setClientPrefill] = useState<any>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmServices, setConfirmServices] = useState<ConfirmService[]>([]);
  const [confirmClient, setConfirmClient] = useState<ConfirmClient | null>(null);
  const [confirmSkipPrompt, setConfirmSkipPrompt] = useState(false);
  const [trackingContactIds, setTrackingContactIds] = useState<string[]>([]);
  useEffect(() => { loadTrackingContactIds(tracking.id).then(setTrackingContactIds).catch(() => {}); }, [tracking.id]);
  const [clientCatalog, setClientCatalog] = useState<Product[]>([]);
  const [clientFormMode, setClientFormMode] = useState<"create" | "attach">("create"); // "attach" = scenario C
  const [attachClientId, setAttachClientId] = useState<string | null>(null);

  // Save the client + project from the form, then fire the deferred handoff.
  const saveClientAndHandoff = async (data: {
    client: { name: string; legalName: string; vatNumber: string; address: any; contacts: any[] };
    products: any[];
  }) => {
   try {
    const newClientId = (globalThis.crypto?.randomUUID?.() ?? String(Math.random()));
    // Create the client with its legal info. Management builds the SERVICES
    // project from the handoff; the signed PRODUCTS go to client_products.
    const clientRow: any = {
      id: newClientId, name: data.client.name,
      legal_name: data.client.legalName || null,
      vat_number: data.client.vatNumber || null,
      address: data.client.address,
      contacts: data.client.contacts,
    };
    if (tracking.company_id) clientRow.company_id = tracking.company_id;
    const { error: cErr } = await supabase.from("clients").insert(clientRow);
    if (cErr) { alert(`Could not save client: ${cErr.message}`); return; }

    // One product-contract row per signed product, with its signing date.
    const pErr = await saveClientProducts(newClientId, tracking.id, data.products.map((p) => ({
      productId: p.productId, price: p.price, quantity: p.quantity, recurring: p.recurring,
      period: p.period, termYears: p.termYears, discountMode: p.discountMode,
      discountValue: p.discountValue, signingDate: p.signingDate,
      startDate: p.startDate, oneTimeFee: p.oneTimeFee, nonTerminableYears: p.nonTerminableYears,
      autoRenew: p.autoRenew, renewYears: p.renewYears, annualIncreasePct: p.annualIncreasePct,
      paymentTermsDays: p.paymentTermsDays, contractRef: p.contractRef, externalRef: p.externalRef,
      billingContactName: data.client.contacts.find((c: any) => c.id === p.billingContactId)?.name ?? null,
      billingContactEmail: data.client.contacts.find((c: any) => c.id === p.billingContactId)?.email ?? null,
    })));
    if (pErr) { alert(`Client created, but products failed: ${pErr}`); }

    setClientFormOpen(false);
    setClientPrefill(null);
    // Client now exists → show the SERVICE confirmation before sending, same as
    // the existing-client path. Build the service cards + client details.
    const svcCards: ConfirmService[] = confirmServiceCards();
    setConfirmClient({
      legalName: data.client.legalName, vatNumber: data.client.vatNumber,
      address: data.client.address, contacts: data.client.contacts,
    });
    setConfirmServices(svcCards);
    setConfirmSkipPrompt(true);
    setConfirmOpen(true);
    // pendingHandoff is already stashed; the confirm's onConfirm will send it.
   } catch (err: any) {
     console.error("saveClientAndHandoff failed:", err);
     alert("Could not open the service handoff: " + (err?.message ?? String(err)));
   }
  };

  // Scenario C: the client already exists and is buying NEW products. We don't
  // create a client — we (optionally) revise the one on file and APPEND the new
  // product contracts to it, so the client accumulates products over time.
  const attachClientAndHandoff = async (data: {
    client: { name: string; legalName: string; vatNumber: string; address: any; contacts: any[] };
    products: any[];
    reviseDetails: boolean;
  }) => {
   try {
    const clientId = attachClientId;
    if (!clientId) { alert("No existing client to attach to."); return; }

    // Revise the client's stored details only if the user chose "Revise details".
    if (data.reviseDetails) {
      const { error: uErr } = await supabase.from("clients").update({
        legal_name: data.client.legalName || null,
        vat_number: data.client.vatNumber || null,
        address: data.client.address,
        contacts: data.client.contacts,
      }).eq("id", clientId);
      if (uErr) { alert(`Could not update client: ${uErr.message}`); return; }
      // New project contacts (no sourceId) also propagate to the company.
      if (tracking.company_id) await syncNewContactsToCompany(tracking.company_id, data.client.contacts).catch(() => {});
    }

    // Append one product-contract row per NEW product, with its signing date.
    const pErr = await saveClientProducts(clientId, tracking.id, data.products.map((p) => ({
      productId: p.productId, price: p.price, quantity: p.quantity, recurring: p.recurring,
      period: p.period, termYears: p.termYears, discountMode: p.discountMode,
      discountValue: p.discountValue, signingDate: p.signingDate,
      startDate: p.startDate, oneTimeFee: p.oneTimeFee, nonTerminableYears: p.nonTerminableYears,
      autoRenew: p.autoRenew, renewYears: p.renewYears, annualIncreasePct: p.annualIncreasePct,
      paymentTermsDays: p.paymentTermsDays, contractRef: p.contractRef, externalRef: p.externalRef,
      billingContactName: data.client.contacts.find((c: any) => c.id === p.billingContactId)?.name ?? null,
      billingContactEmail: data.client.contacts.find((c: any) => c.id === p.billingContactId)?.email ?? null,
    })));
    if (pErr) { alert(`Products failed to save: ${pErr}`); }

    setClientFormOpen(false);
    setClientPrefill(null);
    setAttachClientId(null);
    setClientFormMode("create");

    // Now confirm the SERVICES tied to the new product, then send the handoff.
    const svcCards: ConfirmService[] = confirmServiceCards();
    setConfirmClient({
      legalName: data.client.legalName, vatNumber: data.client.vatNumber,
      address: data.client.address, contacts: data.client.contacts,
    });
    setConfirmServices(svcCards);
    setConfirmSkipPrompt(true); // client already handled here; confirm just sends services
    setConfirmOpen(true);
   } catch (err: any) {
     console.error("attachClientAndHandoff failed:", err);
     alert("Could not attach products: " + (err?.message ?? String(err)));
   }
  };

  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [assignees, setAssignees] = useState<Record<string, Assignee[]>>({});
  const [companyContactIds, setCompanyContactIds] = useState<string[]>([]);

  const reloadAssignees = async () => {
    const ids = [...notes, ...tasks, ...meetings].map((x: any) => x.id);
    setAssignees(await loadAssignees(tracking.id, ids).catch(() => ({})));
  };

  useEffect(() => {
    if (tracking.pipeline_id) loadPipeline(tracking.pipeline_id).then(({ phases }) => {
      // Display order: normal phases first (as configured), then Won, then Lost.
      const rank = (p: any) => p.sales_outcome === "loss" ? 2 : p.sales_outcome === "win" ? 1 : 0;
      const ordered = [...phases].sort((a, b) => rank(a) - rank(b));
      setAllPhases(ordered);
      setPhases(ordered.filter((p) => p.sales_visible !== false));
    }).catch(() => {});
    Promise.all([loadNotes(tracking.id), loadTasks(tracking.id), loadMeetings(tracking.id)]).then(([n, t, m]) => {
      setNotes(n); setTasks(t); setMeetings(m);
      const ids = [...n, ...t, ...m].map((x: any) => x.id);
      loadAssignees(tracking.id, ids).then(setAssignees).catch(() => {});
    }).catch(() => {});
    loadPhaseEvents(tracking.id).then(setEvents).catch(() => {});
    loadServices().then(setServices).catch(() => {});
    listPipelines().then(setAllPipelines).catch(() => {});
    loadPotentialServices(tracking.id).then(setPotentials).catch(() => {});
    loadTrackingProducts(tracking.id).then(setTProds).catch(() => {});
    loadTrackingEmployees(tracking.id).then(setTeam).catch(() => {});
    loadTrackingOwner(tracking.id).then(setOwner).catch(() => {});
    loadTrackingHandoffs(tracking.id).then(setHandoffs).catch(() => {});
    // contacts already linked to this tracking's company
    if (tracking.company_id) {
      supabase.from("company_contacts").select("contact_id").eq("company_id", tracking.company_id)
        .then(({ data }: any) => setCompanyContactIds((data ?? []).map((r: any) => r.contact_id)));
    }
  }, [tracking.id, tracking.pipeline_id, tracking.company_id]);

  useEffect(() => {
    if (curPhase && events.length === 0) {
      stampPhaseEntry(tracking.id, curPhase).then((e) => { if (e) setEvents((xs) => [...xs, e]); }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curPhase, events.length]);

  const company = companies.find((c) => c.id === tracking.company_id);
  const product = products.find((p) => p.id === tracking.product_id);
  const contactName = (id: string) => {
    const c = contacts.find((x) => x.id === id);
    return c ? [c.first_name, c.last_name].filter(Boolean).join(" ") : "Contact";
  };
  const empName = (id: string) => employees.find((e) => e.id === id)?.name ?? "Employee";

  useEffect(() => { myProfile().then(setMe).catch(() => {}); }, []);
  const canAssign = isSalesLead(me);
  // Two deal-level close estimates: the rep's own, and the manager/boss override.
  const [repProb, setRepProb] = useState<number | null>(tracking.rep_close_prob ?? null);
  const [mgrProb, setMgrProb] = useState<number | null>(tracking.mgr_close_prob ?? null);
  const [repDate, setRepDate] = useState<string>(tracking.rep_close_date ?? "");
  const [mgrDate, setMgrDate] = useState<string>(tracking.mgr_close_date ?? "");
  const repTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mgrTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveProb = (which: "rep" | "mgr", v: number | null) => {
    const timer = which === "rep" ? repTimer : mgrTimer;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { setDealCloseProb(tracking.id, which, v); }, 350);
  };
  const toggleMember = async (id: string) => {
    const removing = team.includes(id);
    const next = removing ? team.filter((x) => x !== id) : [...team, id];
    setTeam(next);
    if (removing && owner === id) setOwner(null); // owner left the team
    await setTrackingEmployees(tracking.id, next).catch(() => {});
  };
  // Clicking the star sets/clears the owner. Adds them to the team first if needed.
  const toggleOwner = async (id: string) => {
    if (owner === id) {
      setOwner(null);
      await setTrackingOwner(tracking.id, null).catch(() => {});
      return;
    }
    if (!team.includes(id)) {
      const next = [...team, id];
      setTeam(next);
      await setTrackingEmployees(tracking.id, next).catch(() => {});
    }
    setOwner(id);
    await setTrackingOwner(tracking.id, id).catch(() => {});
  };
  const title = company?.name || (tracking.contactIds[0] ? contactName(tracking.contactIds[0]) : "Untitled");

  // win/loss phases in this pipeline
  const winPhase = phases.find((p) => p.sales_outcome === "win");
  const lossPhase = phases.find((p) => p.sales_outcome === "loss");

  // Every deal service needs a stable routing id — even a custom one with no
  // catalog service_id — or it can't be matched to a destination or handed off.
  const svcKey = (p: any) => (p.service_id ?? ("psvc:" + p.id)) as string;

  // Only the services that belong to the destinations actually being sent.
  // When re-sending after a dismissal, the picked set is just the dismissed
  // destination(s), so the confirm modal must show only THOSE services — not
  // every service on the deal (which would include the ones already pending in
  // management).
  const confirmServiceCards = (): ConfirmService[] => {
    const picked = handoffTargets.filter((t) => handoffPicked.has(t.id));
    const ids = new Set<string>();
    picked.forEach((tg) => (tg.items ?? []).forEach((it: any) => { if (it.type === "service") ids.add(it.id); }));
    const today = new Date().toISOString().slice(0, 10);
    const source = ids.size ? potentials.filter((p) => ids.has(svcKey(p))) : potentials;
    return source.map((p) => ({
      key: p.id,
      serviceId: p.service_id ?? "",
      name: p.label || serviceName(p.service_id),
      line: { ...(p as any) },
      calculator: (serviceOf(p.service_id)?.calculator as Calculator | null) ?? null,
      unit: (serviceUnit(p.service_id) === "hour" ? "hour" : "day"),
      minUnit: serviceMin(p.service_id),
      signingDate: today,
      contactIds: (((p as any).contact_ids ?? []) as string[]),
    }));
  };

  /**
   * Handoff destinations = pipelines referenced by any phase's handover_to.
   *
   * A destination is "recommended" when the handoff phase that points at it
   * lists a product or service this deal actually sold, so the obvious next
   * step is visible without reading every pipeline name.
   */
  const handoffTargets = useMemo(() => {
    const byPipeline = new Map<string, { id: string; name: string; items: { type: string; id: string }[] }>();
    allPhases.filter((ph) => ph.handover_to).forEach((ph) => {
      const id = ph.handover_to as string;
      const entry = byPipeline.get(id) ?? { id, name: allPipelines.find((pl) => pl.id === id)?.name ?? "Pipeline", items: [] };
      entry.items.push(...(ph.items ?? []));
      byPipeline.set(id, entry);
    });

    // Which deal items each destination's phase config claims, and the names
    // actually present on this deal (for the "recommended" badge).
    const matchedOf = (items: { type: string; id: string }[]) => {
      const names: string[] = [];
      items.forEach((it) => {
        if (it.type === "product" && tprods.some((tp) => tp.product_id === it.id)) {
          names.push(products.find((p) => p.id === it.id)?.name ?? "Product");
        }
        if (it.type === "service") {
          const ps = potentials.find((p) => svcKey(p) === it.id);
          if (ps) names.push(ps.label || services.find((s) => s.id === ps.service_id)?.name || "Service");
        }
      });
      return Array.from(new Set(names));
    };

    const arr = Array.from(byPipeline.values())
      .map((e) => ({ id: e.id, name: e.name, items: e.items, matched: matchedOf(e.items) }))
      .sort((a, b) => b.matched.length - a.matched.length || a.name.localeCompare(b.name));

    // Any product/service ON THIS DEAL that no destination's phase config routes
    // is an "orphan" (including custom services with no catalog id). Without this
    // it is silently dropped from the handoff — it still shows in the big confirm,
    // but never reaches management. Attach orphans to the most-recommended
    // destination so the whole deal travels together.
    if (arr.length) {
      const claimed = new Set<string>();
      arr.forEach((e) => e.items.forEach((it) => claimed.add(it.type + ":" + it.id)));
      const orphans: { type: string; id: string }[] = [];
      tprods.forEach((tp) => { if (tp.product_id && !claimed.has("product:" + tp.product_id)) orphans.push({ type: "product", id: tp.product_id }); });
      potentials.forEach((ps) => { const k = svcKey(ps); if (!claimed.has("service:" + k)) orphans.push({ type: "service", id: k }); });
      if (orphans.length) {
        arr[0].items = [...arr[0].items, ...orphans];
        arr[0].matched = matchedOf(arr[0].items);
      }
    }
    return arr;
  }, [allPhases, allPipelines, tprods, potentials, products, services]);
  const canHandoff = status === "won" && handoffTargets.length > 0;

  const curIdx = phases.findIndex((p) => p.id === curPhase);
  // Shared with the overview list (salesApi.trackingPct) so both always agree.
  const pct = trackingPct(phases, curPhase);
  // Close probability from the CURRENT phase (independent of the progress bar).
  const curPhaseObj = curIdx >= 0 ? phases[curIdx] : undefined;
  const closeProb: number | null =
    status === "won" ? 100 :
    status === "lost" ? 0 :
    curPhaseObj?.sales_outcome === "win" ? 100 :
    curPhaseObj?.sales_outcome === "loss" ? 0 :
    curPhaseObj?.close_probability != null ? curPhaseObj.close_probability : null;
  const probTone = closeProb == null ? "none" : closeProb >= 70 ? "hi" : closeProb >= 40 ? "mid" : "lo";
  const phaseEnteredAt = (phaseId: string) => events.find((e) => e.phase_id === phaseId)?.entered_at ?? null;

  // Move to a phase, syncing status from the phase's outcome.
  const applyPhase = async (id: string) => {
    const newIdx = phases.findIndex((p) => p.id === id);
    setCurPhase(id);
    await setTrackingPhase(tracking.id, id);
    // Keep entry dates only up to and including the new current phase; clear later ones.
    const keepIds = phases.slice(0, newIdx + 1).map((p) => p.id);
    const e = await stampPhaseEntry(tracking.id, id);
    await clearPhaseEventsAfter(tracking.id, keepIds);
    setEvents((xs) => {
      let next = xs.filter((ev) => ev.phase_id && keepIds.includes(ev.phase_id));
      if (e && !next.find((x) => x.phase_id === id)) next = [...next, e];
      return next;
    });
    const ph = phases.find((p) => p.id === id);
    const next = ph?.sales_outcome === "win" ? "won" : ph?.sales_outcome === "loss" ? "lost" : "active";
    setStatus(next); await setTrackingStatus(tracking.id, next);
    if (next === "lost") setLossModal(true);
  };

  // Clicking a status button: sync the phase too.
  const applyStatus = async (s: string) => {
    if (s === "won") {
      if (!winPhase) return;
      await applyPhase(winPhase.id);
    } else if (s === "lost") {
      if (!lossPhase) return;
      await applyPhase(lossPhase.id);
    } else {
      // active/paused: if currently on a win/loss phase, step back to the last normal phase
      const cur = phases.find((p) => p.id === curPhase);
      if (cur?.sales_outcome) {
        const normals = phases.filter((p) => !p.sales_outcome);
        const back = normals[normals.length - 1];
        if (back) { setCurPhase(back.id); await setTrackingPhase(tracking.id, back.id); }
      }
      setStatus(s); await setTrackingStatus(tracking.id, s);
    }
  };

  const remove = () => ask({ title: "Delete tracking", message: `The deal “${title}” and its notes, tasks, meetings and files will be permanently removed.`, confirmLabel: "Delete tracking", onConfirm: async () => { await deleteTracking(tracking.id); onBack(); } });



  // People available to @-mention: employees (internal) + contacts linked to the client's company.
  const mentionPeople = useMemo<MentionPerson[]>(() => {
    const niceName = (raw: string) => {
      const n = (raw ?? "").trim();
      if (!n || n === "-") return "";
      // If it's an email, use the part before "@" as a friendlier fallback.
      return n.includes("@") ? n.split("@")[0] : n;
    };
    const emps: MentionPerson[] = employees
      .map((e) => ({ id: `employee:${e.id}`, name: niceName(e.name), kind: "employee" as const }))
      .filter((e) => e.name);
    const linked: MentionPerson[] = contacts
      .filter((c) => companyContactIds.includes(c.id!))
      .map((c) => ({ id: `contact:${c.id}`, name: [c.first_name, c.last_name].filter(Boolean).join(" "), kind: "contact" }));
    return [...emps, ...linked];
  }, [employees, contacts, companyContactIds]);

  const unassign = async (itemId: string, assigneeId: string) => {
    await removeAssignee(assigneeId);
    setAssignees((prev) => ({ ...prev, [itemId]: (prev[itemId] ?? []).filter((a) => a.id !== assigneeId) }));
  };

  // Extract mention ids still present in the serialized text "@[Name](id)".
  const extractMentions = (t: string): { id: string; name: string }[] => {
    const out: { id: string; name: string }[] = [];
    const re = /@\[([^\]]+)\]\(([^)]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) out.push({ name: m[1], id: m[2] });
    return out;
  };
  // Convert serialized mentions "@[Name](id)" into plain "@Name" for storage.
  const cleanMentions = (t: string) => cleanMentionsFn(t);

  // Persist the mentions found in the final text against a freshly-created item.
  const persistFromText = async (itemType: string, itemId: string, rawText: string) => {
    const mentions = extractMentions(rawText);
    const seen = new Set<string>();
    const created: any[] = [];
    // Someone already tagged on this item must not be added twice when the
    // text is edited and mentions are typed again.
    const already = new Set(
      (assignees[itemId] ?? []).map((a) => `${a.kind}:${a.kind === "employee" ? a.employee_id : a.contact_id}`),
    );
    for (const mn of mentions) {
      if (seen.has(mn.id)) continue; seen.add(mn.id);
      if (already.has(mn.id)) continue;
      const [kind, refId] = mn.id.split(":") as ["employee" | "contact", string];
      if (!refId) continue;
      const a = await addAssignee(itemType, itemId, kind, refId);
      if (a) created.push(a);
    }
    if (created.length) setAssignees((prev) => ({ ...prev, [itemId]: [...(prev[itemId] ?? []), ...created] }));
  };

  // ---- add handlers ----
  const [newNote, setNewNote] = useState("");
  const submitNote = async () => {
    if (!cleanMentions(newNote).trim()) return;
    const n = await addNote(tracking.id, curPhase, newNote.trim());
    if (n) { setNotes((xs) => [...xs, n]); await persistFromText("note", n.id, newNote); }
    setNewNote("");
  };
  const removeNote = (id: string) => ask({ title: "Delete note", message: "This note will be permanently removed.", confirmLabel: "Delete note", onConfirm: async () => { await deleteNote(id); setNotes((xs) => xs.filter((n) => n.id !== id)); } });
  const editNote = async (id: string, raw: string) => {
    await updateNote(id, raw.trim());
    setNotes((xs) => xs.map((n) => n.id === id ? { ...n, body: raw.trim() } : n));
    await persistFromText("note", id, raw);
  };

  const [newTask, setNewTask] = useState("");
  const [taskDue, setTaskDue] = useState("");        // date "YYYY-MM-DD"
  const [taskDueTime, setTaskDueTime] = useState("18:00");
  const submitTask = async () => {
    if (!cleanMentions(newTask).trim() || !taskDue) return;
    const dueIso = `${taskDue}T${taskDueTime || "00:00"}:00`;
    const t = await addTask(tracking.id, curPhase, newTask.trim(), dueIso);
    if (t) { setTasks((xs) => [...xs, t]); await persistFromText("task", t.id, newTask); }
    setNewTask(""); setTaskDue(""); setTaskDueTime("18:00");
  };
  const flipTask = async (t: TrackTask) => { const done = !t.done; setTasks((xs) => xs.map((x) => x.id === t.id ? { ...x, done } : x)); await toggleTask(t.id, done); };
  const removeTask = (id: string) => ask({ title: "Delete task", message: "This task will be permanently removed.", confirmLabel: "Delete task", onConfirm: async () => { await deleteTask(id); setTasks((xs) => xs.filter((t) => t.id !== id)); } });
  const editTask = async (id: string, raw: string) => {
    await updateTask(id, { title: raw.trim() });
    setTasks((xs) => xs.map((t) => t.id === id ? { ...t, title: raw.trim() } : t));
    await persistFromText("task", id, raw);
  };
  const editTaskDue = async (id: string, dueIso: string | null) => {
    await updateTask(id, { due_at: dueIso });
    setTasks((xs) => xs.map((t) => t.id === id ? { ...t, due_at: dueIso } : t));
  };
  // Overdue = has a deadline in the past and not done.
  const isOverdue = (t: TrackTask) => !t.done && !!t.due_at && new Date(t.due_at).getTime() < Date.now();
  const overdueCount = tasks.filter(isOverdue).length;

  // ---- Proposal generation (PPT / PDF) ----
  const [propMenu, setPropMenu] = useState(false);
  const [propBusy, setPropBusy] = useState<null | "pptx" | "pdf">(null);
  const [propErr, setPropErr] = useState<string | null>(null);
  const buildProposalData = (sel?: Record<string, { include: boolean; versionId: string }>, phaseOverride?: Record<string, { name: string; days: number; tasks: string[] }[]>): ProposalData => {
    const co: any = company ?? {};
    const primaryContact = tracking.contactIds[0] ? contacts.find((x) => x.id === tracking.contactIds[0]) : undefined;
    // Resolve which product/service line to use per group: the selected version,
    // or the active one when no selection is given.
    const pickProd = (vg: string) => {
      const chosen = sel?.[`p:${vg}`];
      if (chosen && !chosen.include) return null;
      const grp = groupOf(tprods, vg);
      return (chosen && grp.find((x) => x.id === chosen.versionId)) || activeOfGroup(tprods, vg);
    };
    const pickSvc = (vg: string) => {
      const chosen = sel?.[`s:${vg}`];
      if (chosen && !chosen.include) return null;
      const grp = groupOf(potentials, vg);
      return (chosen && grp.find((x) => x.id === chosen.versionId)) || activeOfGroup(potentials, vg);
    };
    const prodGroups = Array.from(new Set(tprods.map((p) => p.version_group ?? p.id)));
    const svcGroups = Array.from(new Set(potentials.map((p) => p.version_group ?? p.id)));

    const productsOut = prodGroups.map((vg) => pickProd(vg as string)).filter(Boolean).map((tp: any) => {
      const prod = productOf(tp.product_id);
      const base = prod?.tiers?.find((x) => x.id === tp.tier_id)?.price;
      const bd = lineBreakdown(tp, prod?.calculator as Calculator | null, base);
      return {
        name: productName(tp.product_id), tier: prod?.tiers?.find((x) => x.id === tp.tier_id)?.name,
        recurring: !!tp.recurring, period: (tp.period as any) ?? "yearly", termYears: Number(tp.term_years ?? 1) || 1,
        unitPrice: bd.unitPrice, qty: Number(tp.quantity ?? 1) || 1,
        rows: bd.rows.map((r) => ({ label: r.label, detail: r.detail, amount: r.amount })),
        discount: bd.discount, total: bd.total,
      };
    });
    const servicesOut = svcGroups.map((vg) => ({ vg, p: pickSvc(vg as string) })).filter((x) => x.p).map(({ vg, p }: any) => {
      const svc = serviceOf(p.service_id);
      const bd = lineBreakdown(p, svc?.calculator as Calculator | null, undefined, serviceMin(p.service_id));
      const unit = (serviceUnit(p.service_id) === "hour" ? "hour" : "day") as "hour" | "day";
      const ov = phaseOverride?.[`s:${vg}`];
      const rateRows = bd.rows.filter((r: any) => r.days && r.days > 0);
      const phases = ov
        ? ov.map((f) => ({ name: f.name, bullets: f.tasks ?? [], days: f.days }))
        : (rateRows.length ? rateRows.map((r: any) => ({ name: r.label, bullets: r.detail ? [r.detail] : [], days: r.days })) : [{ name: p.label || serviceName(p.service_id), bullets: [], days: bd.qty }]);
      return {
        name: p.label || serviceName(p.service_id), unit, days: bd.qty, rate: bd.unitPrice,
        rows: bd.rows.map((r: any) => ({ label: r.label, detail: r.detail, amount: r.amount, days: r.days })),
        phases, discount: bd.discount, total: bd.total,
      };
    });
    const pt = productsOut.reduce((s, x) => s + x.total, 0), st = servicesOut.reduce((s, x) => s + x.total, 0);
    return {
      client: { name: co.name ?? title, legalName: co.legal_name ?? undefined, vat: co.vat_number ?? undefined,
        address: [co.street, co.addr_number, co.postal_code, co.city, co.country].filter(Boolean).join(", ") || undefined,
        contactName: primaryContact ? [primaryContact.first_name, primaryContact.last_name].filter(Boolean).join(" ") : undefined,
        contactRole: primaryContact?.position ?? undefined, contactEmail: primaryContact?.email ?? undefined },
      deal: { title, date: new Date().toISOString().slice(0, 10), ref: tracking.id.slice(0, 8).toUpperCase() },
      products: productsOut, services: servicesOut,
      totals: { products: pt, services: st, discount: productsOut.reduce((s, x) => s + x.discount, 0) + servicesOut.reduce((s, x) => s + x.discount, 0), total: pt + st },
    };
  };
  const [propPick, setPropPick] = useState<null | "pptx" | "pdf">(null);
  const [phaseEditor, setPhaseEditor] = useState<null | { sel: Record<string, { include: boolean; versionId: string }>; services: { key: string; name: string; totalDays: number; minUnit: number; phases: { name: string; percent: number; days: number; tasks: string[] }[] }[] }>(null);
  const runProposal = (kind: "pptx" | "pdf") => { setPropMenu(false); setPropPick(kind); };

  const generateWithSel = async (kind: "pptx" | "pdf", sel: Record<string, { include: boolean; versionId: string }>, phaseOverride?: Record<string, { name: string; days: number; tasks: string[] }[]>) => {
    setPropBusy(kind); setPropErr(null);
    try {
      const tpl = await loadProposalTemplate();
      if (!tpl) { setPropErr("No proposal template configured for your company yet."); return; }
      await generateProposal(kind, buildProposalData(sel, phaseOverride), tpl);
    } catch (e: any) { setPropErr(e?.message ?? "Could not generate the proposal."); }
    finally { setPropBusy(null); }
  };

  const doGenerate = async (kind: "pptx" | "pdf", sel: Record<string, { include: boolean; versionId: string }>) => {
    setPropPick(null);
    // Only the deck shows phase tables; the PDF stays as-is.
    if (kind === "pptx") {
      // Which service groups are included?
      const svcGroups = Array.from(new Set(potentials.map((p) => p.version_group ?? p.id)))
        .filter((vg) => sel[`s:${vg}`]?.include !== false);
      const picked = svcGroups.map((vg) => {
        const chosen = sel[`s:${vg}`];
        const grp = groupOf(potentials, vg as string);
        return (chosen && grp.find((x) => x.id === chosen.versionId)) || activeOfGroup(potentials, vg as string);
      }).filter(Boolean) as any[];
      const serviceIds = Array.from(new Set(picked.map((p) => p.service_id).filter(Boolean)));
      if (serviceIds.length) {
        setPropBusy("pptx");
        const bps = await loadBlueprintsForServices(serviceIds).catch(() => ({} as Record<string, PhaseBlueprint>));
        setPropBusy(null);
        const editorServices = picked.filter((p) => p.service_id && bps[p.service_id]).map((p) => {
          const bd = lineBreakdown(p, serviceOf(p.service_id)?.calculator as Calculator | null, undefined, serviceMin(p.service_id));
          const totalDays = bd.qty; const minUnit = serviceMin(p.service_id) || 0.5;
          const bp = bps[p.service_id!];
          const phases = bp.phases.map((ph) => ({
            name: ph.name, percent: ph.percent,
            days: billableQty((totalDays * (ph.percent || 0)) / 100, minUnit),
            tasks: (ph.tasks ?? []).map((tk) => tk.name),
          }));
          return { key: `s:${p.version_group ?? p.id}`, name: p.label || serviceName(p.service_id), totalDays, minUnit, phases };
        });
        if (editorServices.length) { setPhaseEditor({ sel, services: editorServices }); return; }
      }
    }
    await generateWithSel(kind, sel);
  };

  const [meetTitle, setMeetTitle] = useState("");
  const [meetDate, setMeetDate] = useState("");
  const [meetTime, setMeetTime] = useState("10:00");
  const [meetKind, setMeetKind] = useState<MeetingKind>("in_person");
  const submitMeeting = async () => {
    if (!cleanMentions(meetTitle).trim() || !meetDate) return;
    const iso = `${meetDate}T${meetTime || "00:00"}:00`;
    const m = await addMeeting(tracking.id, curPhase, meetTitle.trim(), iso, meetKind);
    if (m) { setMeetings((xs) => [...xs, m]); await persistFromText("meeting", m.id, meetTitle); }
    setMeetTitle(""); setMeetDate(""); setMeetTime("10:00");
  };
  const removeMeeting = (id: string) => ask({ title: "Delete meeting", message: "This meeting will be permanently removed.", confirmLabel: "Delete meeting", onConfirm: async () => { await deleteMeeting(id); setMeetings((xs) => xs.filter((m) => m.id !== id)); } });
  const editMeeting = async (id: string, raw: string) => {
    await updateMeeting(id, { title: raw.trim() });
    setMeetings((xs) => xs.map((m) => m.id === id ? { ...m, title: raw.trim() } : m));
    await persistFromText("meeting", id, raw);
  };
  const setMeetingKind = async (id: string, kind: MeetingKind) => {
    setMeetings((xs) => xs.map((m) => m.id === id ? { ...m, kind } : m));
    await updateMeeting(id, { kind });
  };

  // ---- revenue ----
  const serviceName = (id: string | null) => services.find((s) => s.id === id)?.name ?? "Service";
  const serviceUnit = (id: string | null) => services.find((s) => s.id === id)?.rate_unit ?? "day";
  const serviceMin = (id: string | null) => {
    const s = services.find((x) => x.id === id);
    return s?.min_unit ?? (s?.rate_unit === "hour" ? 0.5 : 0.25);
  };
  const productName = (id: string | null) => products.find((p) => p.id === id)?.name ?? "Product";
  const availableProducts = products.filter((p) => !tprods.some((tp) => tp.product_id === p.id));

  const addProduct = async (productId: string) => {
    const prod = products.find((p) => p.id === productId);
    const price = prod?.tiers?.[0]?.price ?? 0;
    // Inherit the recurrence straight from the catalogue so the line is right
    // the moment it appears.
    const row = await addTrackingProduct(tracking.id, productId, price, {
      recurring: prod?.billing === "recurring",
      period: (prod?.billing_period as "monthly" | "yearly") ?? "yearly",
      term_years: 1,
    });
    if (row) setTProds((xs) => [...xs, row]);
  };
  const patchProduct = async (id: string, patch: TermPatch) => {
    setTProds((xs) => xs.map((p) => p.id === id ? { ...p, ...patch } : p));
    const err = await updateTrackingProduct(id, tracking.id, patch);
    setRevErr(err);
    // The optimistic edit above is a lie if the write failed, so put the row back.
    if (err) loadTrackingProducts(tracking.id).then(setTProds).catch(() => {});
  };
  const removeProduct = async (id: string) => {
    await removeTrackingProduct(id, tracking.id);
    setTProds((xs) => xs.filter((p) => p.id !== id));
  };

  const addPotential = async (serviceId: string) => {
    const svc = services.find((s) => s.id === serviceId);
    const price = svc?.roles?.reduce((sum: number, r: any) => sum + (r.price || 0), 0) ?? 0;
    const p = await addPotentialService(tracking.id, serviceId, svc?.name ?? null, price);
    if (p) setPotentials((xs) => [...xs, p]);
  };
  const patchPotential = async (id: string, patch: TermPatch) => {
    setPotentials((xs) => xs.map((p) => p.id === id ? { ...p, ...patch } : p));
    const err = await updatePotentialServiceTerm(id, patch);
    setRevErr(err);
    if (err) loadPotentialServices(tracking.id).then(setPotentials).catch(() => {});
  };
  const removePotential = async (id: string) => { await deletePotentialService(id); setPotentials((xs) => xs.filter((p) => p.id !== id)); };

  const productOf = (id: string | null) => products.find((p) => p.id === id);
  const serviceOf = (id: string | null) => services.find((s) => s.id === id);

  // Per-line versioning: lines carry a version_group; only the active one of
  // each group shows and counts. Helpers to navigate versions per card.
  const groupOf = (list: any[], vg: string | null | undefined) =>
    list.filter((x) => (x.version_group ?? x.id) === (vg ?? "__none__"))
      .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  const activeOfGroup = (list: any[], vg: string | null | undefined) => {
    const g = groupOf(list, vg);
    return g.find((x) => x.version_active) ?? g[g.length - 1];
  };
  // The distinct groups, each represented by its active line.
  const activeTprods = (() => {
    const seen = new Set<string>(); const out: TrackingProduct[] = [];
    tprods.forEach((p) => { const vg = p.version_group ?? p.id; if (seen.has(vg)) return; seen.add(vg); const a = activeOfGroup(tprods, vg); if (a) out.push(a); });
    return out;
  })();
  const activePotentials = (() => {
    const seen = new Set<string>(); const out: PotentialService[] = [];
    potentials.forEach((p) => { const vg = p.version_group ?? p.id; if (seen.has(vg)) return; seen.add(vg); const a = activeOfGroup(potentials, vg); if (a) out.push(a); });
    return out;
  })();

  const switchProdVersion = async (vg: string, id: string) => {
    setTProds((xs) => xs.map((x) => (x.version_group ?? x.id) === vg ? { ...x, version_active: x.id === id } : x));
    await setLineVersionActive("tracking_products", vg, id).catch(() => {});
  };
  const switchSvcVersion = async (vg: string, id: string) => {
    setPotentials((xs) => xs.map((x) => (x.version_group ?? x.id) === vg ? { ...x, version_active: x.id === id } : x));
    await setLineVersionActive("tracking_potential_services", vg, id).catch(() => {});
  };
  const newProdVersion = async (sourceId: string, copy: boolean) => {
    const row = await addProductVersion(sourceId, copy).catch(() => null);
    if (row) setTProds((xs) => [...xs.map((x) => x.version_group === row.version_group ? { ...x, version_active: false } : x), row]);
  };
  const newSvcVersion = async (sourceId: string, copy: boolean) => {
    const row = await addServiceVersion(sourceId, copy).catch(() => null);
    if (row) setPotentials((xs) => [...xs.map((x) => x.version_group === row.version_group ? { ...x, version_active: false } : x), row]);
  };

  const productsTotal = activeTprods.reduce((s, p) => {
    const prod = productOf(p.product_id);
    const base = prod?.tiers?.find((x) => x.id === p.tier_id)?.price;
    return s + lineTotal(p, prod?.calculator as Calculator | null, base);
  }, 0);
  const totalPotential = productsTotal + activePotentials.reduce(
    (s, p) => s + lineTotal(p, serviceOf(p.service_id)?.calculator as Calculator | null, undefined, serviceMin(p.service_id)), 0);
  const money = (n: number) =>
    `\u20ac${(Number(n) || 0).toLocaleString("es-ES", { maximumFractionDigits: 0 })}`;

  /**
   * Latest state per destination pipeline. A dismissed handoff is not the same
   * as never having sent one - management looked at it and rejected it - so it
   * is surfaced as a warning rather than silently allowing a resend.
   */
  const handoffState = useMemo(() => {
    const m: Record<string, string> = {};
    handoffs.forEach((h) => {
      if (!h.dest_pipeline_id) return;
      // The database nulls these when the client or project is deleted, so a
      // converted handoff with nothing left behind it is stale, not done.
      const gone = h.status === "converted" && !h.created_project_id && !h.created_client_id;
      m[h.dest_pipeline_id] = gone ? "removed" : h.status;
    });
    return m;
  }, [handoffs]);
  const dismissedTargets = handoffTargets.filter((tg) => handoffState[tg.id] === "dismissed");
  const removedTargets = handoffTargets.filter((tg) => handoffState[tg.id] === "removed");
  const liveHandoffs = handoffs.filter(
    (h) => h.status === "pending" || (h.status === "converted" && (h.created_project_id || h.created_client_id)),
  );

  // Opening the menu pre-ticks whatever this deal actually sold.
  useEffect(() => {
    if (!handoffMenu) return;
    // Never pre-tick something that is already sitting in management.
    setHandoffPicked(new Set(
      handoffTargets
        .filter((t) => t.matched.length && handoffState[t.id] !== "pending" && handoffState[t.id] !== "converted")
        .map((t) => t.id),
    ));
  }, [handoffMenu]);

  const doHandoff = async () => {
   try {
    const picked = handoffTargets.filter((t) => handoffPicked.has(t.id));
    if (!picked.length) return;

    /**
     * Each destination only receives what belongs to it: the products and
     * services listed on the handoff phase that points at that pipeline.
     * Sending the whole deal to every destination made every card in
     * management look identical.
     */
    const destinations = picked.map((tg) => {
      const ids = new Set((tg.items ?? []).map((it: any) => it.id));
      const lines: any[] = [];

      tprods.filter((tp) => tp.product_id && ids.has(tp.product_id)).forEach((tp) => {
        const prod = productOf(tp.product_id);
        const base = prod?.tiers?.find((x) => x.id === tp.tier_id)?.price;
        const bd = lineBreakdown(tp, prod?.calculator as Calculator | null, base);
        lines.push({
          label: productName(tp.product_id), kind: "product",
          price: Math.round(bd.total),
          gross: Math.round(bd.gross), discount: Math.round(bd.discount),
          rows: bd.rows.map((r) => ({ label: r.label, detail: r.detail, amount: r.amount, discount: r.discount })),
        });
      });

      potentials.filter((p) => ids.has(svcKey(p))).forEach((p) => {
        const svcCalc = serviceOf(p.service_id)?.calculator as Calculator | null;
        const minU = serviceMin(p.service_id);
        const bd = lineBreakdown(p, svcCalc, undefined, minU);
        // Days behind each row, so management can see how the total was built.
        const timeRows = svcCalc && svcCalc.output_kind === "quantity"
          ? calcBreakdown(svcCalc, p.calc_values ?? {}, Number(svcCalc.base_amount) || 0).rows
          : [];
        // Management receives the billable quantity, never the raw one, so the
        // project it creates lines up with what was sold.
        const days = bd.qty;
        // The real per-day rate is the line's base rate (what the Line
        // Calculator shows as "Rate per day"), not total/days. For quantity
        // calculators the base rate lives in p.price; fall back to the net unit
        // price for flat lines, and only then to an average.
        const baseRate = Number(p.price) || 0;
        const lineRate = svcCalc?.output_kind === "quantity"
          ? baseRate
          : (days > 0 ? Math.round(bd.total / days) : Math.round(bd.total));
        lines.push({
          label: p.label || serviceName(p.service_id), kind: "service",
          price: Math.round(bd.total), days,
          gross: Math.round(bd.gross), discount: Math.round(bd.discount),
          rate: Math.round(lineRate),
          rows: bd.rows.map((r) => {
            const tr = timeRows.find((x) => x.key === r.key);
            const d = tr ? tr.amount : undefined;
            return {
              label: r.label, detail: r.detail, amount: r.amount, discount: r.discount,
              days: d, rate: d && d > 0 ? Math.round(r.amount / d) : undefined,
            };
          }),
        });
      });

      return {
        id: tg.id, name: tg.name, services: lines,
        // Management delivers the service, not the licence, so the value they
        // see is the service work only. Products travel as context.
        potential_value: lines.filter((l) => l.kind !== "product")
          .reduce((s, l) => s + (l.price || 0), 0),
      };
    });

    // Management keys clients by company. If no client exists yet for this
    // company, sales must create it (with legal info) BEFORE the handoff builds
    // a project. Open the prefilled form; the handoff fires once it's saved.
    const exists = await clientExistsForCompany(tracking.company_id);
    if (!exists && tracking.company_id) {
      const [prefill, catalog] = await Promise.all([
        buildClientPrefill(tracking.company_id, tracking.id),
        listCatalogProducts(),
      ]);
      // Catalog minus products already on the deal, so the picker only offers new ones.
      // Pass the FULL catalog: the form needs every product's calculator/tiers
      // (including the deal's own products). The picker filters internally.
      setClientCatalog(catalog);
      setPendingHandoff(destinations);
      setClientPrefill(prefill);
      setClientFormMode("create");
      setClientFormOpen(true);
      setHandoffMenu(false);
      return;
    }

    // Client EXISTS and this deal carries new PRODUCTS → scenario C (attach). But
    // if THIS tracking's products were already written to client_products (the
    // client was created earlier in this same deal and only the services still
    // need sending), skip the attach prompt and go straight to the services
    // confirm below — re-capturing the products would duplicate them.
    const productsAlreadyCaptured = await hasClientProductsForTracking(tracking.id);
    if (exists && tracking.company_id && tprods.length > 0 && !productsAlreadyCaptured) {
      const [attach, catalog] = await Promise.all([
        buildAttachPrefill(tracking.company_id, tracking.id),
        listCatalogProducts(),
      ]);
      if (attach) {
        setClientCatalog(catalog as any);
        setPendingHandoff(destinations);
        setClientPrefill(attach.prefill);
        setAttachClientId(attach.clientId);
        setClientFormMode("attach");
        setClientFormOpen(true);
        setHandoffMenu(false);
        return;
      }
      // Couldn't load the client record → fall through to services-only.
    }

    // Client exists → confirm the SERVICES (with editable calculators) before
    // sending. Build the service cards from this deal's potentials.
    const svcCards: ConfirmService[] = confirmServiceCards();
    // Prefill client legal/address/contacts from the company for the edit popup.
    const pre = tracking.company_id ? await buildClientPrefill(tracking.company_id, tracking.id) : null;
    setConfirmClient(pre ? { legalName: pre.legalName, vatNumber: pre.vatNumber, address: pre.address, contacts: pre.contacts } : { legalName: "", vatNumber: "", address: { street: "", number: "", details: "", postalCode: "", city: "", country: "" }, contacts: [] });
    setConfirmServices(svcCards);
    setConfirmSkipPrompt(false);
    setPendingHandoff(destinations);
    setConfirmOpen(true);
    setHandoffMenu(false);
    return;
   } catch (err: any) {
     console.error("doHandoff failed:", err);
     alert("Handoff failed: " + (err?.message ?? String(err)));
   }
  };

  // The actual write, shared by the direct path and the after-client-created path.
  const sendHandoff = async (destinations: { id: string; name: string; services: any[]; potential_value: number }[]) => {
    await createHandoffs({
      tracking_id: tracking.id,
      company_id: tracking.company_id,
      company_name: company?.name ?? null,
      product_id: tracking.product_id,
      destinations,
    });
    setHandoffSent(true);
    loadTrackingHandoffs(tracking.id).then(setHandoffs).catch(() => {});
  };

  const fmtMeet = (iso: string | null) => iso ? new Date(iso).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "-";
  const fmtDate = (iso: string | null) => iso ? new Date(iso).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "2-digit" }) : null;

  // Assignee row (chips + dropdown) reused across items
  // Small "people tagged" indicator: avatars if they fit, else an icon; hover shows who in a portal popup.
  const MiniAssignees = ({ itemId, compact }: { itemId: string; compact?: boolean }) => {
    const list = assignees[itemId] ?? [];
    const [hover, setHover] = useState(false);
    const wrapRef = useRef<HTMLSpanElement>(null);
    const [pop, setPop] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
    if (list.length === 0) return null;
    const rows = list.map((a) => {
      const isEmp = a.kind === "employee";
      return { key: a.id, isEmp, name: isEmp ? empName(a.employee_id!) : contactName(a.contact_id!) };
    });
    const open = () => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (r) setPop({ left: r.right, top: r.top });
      setHover(true);
    };
    const popup = hover && createPortal(
      <span className="sl-tag-pop" style={{ position: "fixed", left: pop.left, top: pop.top, transform: "translate(-100%, calc(-100% - 6px))" }}>
        {rows.map((r) => (
          <span key={r.key} className="sl-tag-pop-row">
            <span className={`sl-mini-av ${r.isEmp ? "sl-asg-int" : "sl-asg-ext"}`}>{r.name.slice(0, 1).toUpperCase()}</span>
            <span className="sl-tag-pop-name">{r.name}</span>
            <span className="sl-tag-pop-kind">{r.isEmp ? "Team" : "Contact"}</span>
          </span>
        ))}
      </span>,
      document.body
    );
    if (compact) {
      return (
        <span className="sl-tagged-wrap" ref={wrapRef} onMouseEnter={open} onMouseLeave={() => setHover(false)}>
          <span className="sl-tagged">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>
            {list.length}
          </span>
          {popup}
        </span>
      );
    }
    const shown = rows.slice(0, 2);
    const extra = rows.length - shown.length;
    return (
      <span className="sl-tagged-wrap" ref={wrapRef} onMouseEnter={open} onMouseLeave={() => setHover(false)}>
        <span className="sl-mini-asg">
          {shown.map((r) => <span key={r.key} className={`sl-mini-av ${r.isEmp ? "sl-asg-int" : "sl-asg-ext"}`}>{r.name.slice(0, 1).toUpperCase()}</span>)}
          {extra > 0 && <span className="sl-mini-more">+{extra}</span>}
        </span>
        {popup}
      </span>
    );
  };

  const AssigneeArea = ({ itemId }: { itemId: string }) => {
    const list = assignees[itemId] ?? [];
    if (list.length === 0) return null;
    return (
      <div className="sl-assignees">
        {list.map((a) => {
          const isEmp = a.kind === "employee";
          const name = isEmp ? empName(a.employee_id!) : contactName(a.contact_id!);
          return (
            <span key={a.id} className={`sl-asg ${isEmp ? "sl-asg-int" : "sl-asg-ext"}`}>
              <span className="sl-asg-av">{name.slice(0, 1).toUpperCase()}</span>
              {name}
              <button onClick={() => unassign(itemId, a.id)} aria-label="Remove">×</button>
            </span>
          );
        })}
      </div>
    );
  };

  return (
    <div className="sl sl-detail">
      <header className="sl-head sl-d-head">
        <button className="sl-back" onClick={onBack} aria-label="Back">‹</button>
        <span className="sl-d-avatar">{title.slice(0, 1).toUpperCase()}</span>
        <div className="sl-d-id">
          <h1 className="sl-title">{title}</h1>
          <div className="sl-d-metaline">
            <span className={`sl-d-badge sl-badge-${status}`}>{status}</span>
            <span className="sl-d-sub">
              {company ? "Company" : "Contact"}
              {tracking.contactIds.length > 0 && ` \u00b7 ${tracking.contactIds.map(contactName).join(", ")}`}
              {product && ` \u00b7 ${product.name}`}
            </span>
          </div>
        </div>
        <div className="sl-d-actions">
          {canHandoff && (
            <div className="sl-handoff-wrap">
              <button className={`sl-handoff-btn ${liveHandoffs.length ? "is-sent" : ""}`} onClick={() => setHandoffMenu((v) => !v)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                Handoff
              </button>
              {handoffMenu && (
                <>
                  <div className="sl-handoff-layer" onMouseDown={() => { setHandoffMenu(false); setHandoffSent(false); }} />
                  <div className="sl-handoff-pop">
                    {handoffSent ? (
                      <div className="sl-handoff-done">
                        <span className="sl-handoff-done-ico">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                        </span>
                        <p className="sl-handoff-done-txt">Handed off</p>
                        <ul className="sl-handoff-done-list">
                          {handoffTargets.filter((tg) => handoffPicked.has(tg.id)).map((tg) => (
                            <li key={tg.id}>{tg.name}</li>
                          ))}
                        </ul>
                        <p className="sl-handoff-done-sub">Waiting in Management, under Incoming.</p>
                        <button className="sl-handoff-done-btn" onClick={() => { setHandoffMenu(false); setHandoffSent(false); }}>Done</button>
                      </div>
                    ) : (
                      <>
                        {removedTargets.length > 0 && (
                          <div className="sl-handoff-warn">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
                            <span>{removedTargets.map((d) => d.name).join(", ")}: the project created in management was deleted. You can send again.</span>
                          </div>
                        )}
                        {dismissedTargets.length > 0 && (
                          <div className="sl-handoff-warn">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
                            <span>{dismissedTargets.map((d) => d.name).join(", ")} {dismissedTargets.length === 1 ? "was" : "were"} dismissed in management. You can send again.</span>
                          </div>
                        )}
                        <div className="sl-handoff-head">Hand off to</div>
                        <div className="sl-handoff-list">
                          {handoffTargets.map((tg) => {
                            const on = handoffPicked.has(tg.id);
                            const rec = tg.matched.length > 0;
                            const st = handoffState[tg.id];
                            const locked = st === "pending" || st === "converted";
                            const why = st === "dismissed" ? "Dismissed in management"
                              : st === "removed" ? "Deleted in management"
                              : rec ? tg.matched.join(" · ") : "";
                            return (
                              <button key={tg.id} disabled={locked}
                                className={`sl-handoff-dest ${on ? "is-picked" : ""} ${rec && !locked ? "is-rec" : ""} ${locked ? "is-locked" : ""} ${st === "dismissed" || st === "removed" ? "is-dismissed" : ""}`}
                                title={locked ? "Already handed off - dismiss it in management to send again" : ""}
                                onClick={() => setHandoffPicked((prev) => {
                                  const n = new Set(prev);
                                  if (n.has(tg.id)) n.delete(tg.id); else n.add(tg.id);
                                  return n;
                                })}>
                                <span className={`sl-handoff-check ${on ? "is-on" : ""} ${locked ? "is-locked" : ""}`}>
                                  {locked ? "✓" : on ? "✓" : ""}
                                </span>
                                <span className="sl-handoff-dest-txt">
                                  <span className="sl-handoff-dest-name">{tg.name}</span>
                                  {why && <span className={`sl-handoff-dest-why ${st === "dismissed" ? "is-warn" : ""}`}>{why}</span>}
                                </span>
                                {st === "converted" ? <span className="sl-handoff-badge is-done">client created</span>
                                  : st === "pending" ? <span className="sl-handoff-badge is-wait">in management</span>
                                  : st === "dismissed" ? <span className="sl-handoff-badge is-warn">dismissed</span>
                                  : st === "removed" ? <span className="sl-handoff-badge is-warn">deleted</span>
                                  : rec ? <span className="sl-handoff-badge">sold</span> : null}
                              </button>
                            );
                          })}
                        </div>
                        <button className="sl-handoff-send" disabled={handoffPicked.size === 0} onClick={doHandoff}>
                          Send{handoffPicked.size > 0 ? ` to ${handoffPicked.size}` : ""}
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
          <div className="sl-seg">
            {["active", "won", "lost", "paused"].map((s) => {
              const disabled = (s === "won" && !winPhase) || (s === "lost" && !lossPhase);
              return (
                <button key={s} className={`sl-seg-btn ${status === s ? "is-on" : ""} sl-seg-${s}`} disabled={disabled}
                  onClick={() => applyStatus(s)} title={disabled ? "Define a win/loss phase in the pipeline first" : ""}>{s}</button>
              );
            })}
          </div>
          <div className="sl-team-wrap">
            <button className={`sl-team-btn ${team.length ? "has-people" : ""}`} onClick={() => setTeamMenu((v) => !v)} title="Who is on this deal">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>
              {team.length > 0 && <span className="sl-team-btn-n">{team.length}</span>}
            </button>
            {teamMenu && (
              <>
                <div className="sl-handoff-layer" onMouseDown={() => setTeamMenu(false)} />
                <div className="sl-team-pop">
                  <div className="sl-team-pop-head">Who is on this deal</div>
                  {employees.length === 0 ? (
                    <p className="sl-team-pop-empty">No people available.</p>
                  ) : (
                    <div className="sl-team-pop-list">
                      {employees.map((e) => {
                        const on = team.includes(e.id);
                        const isOwner = owner === e.id;
                        return (
                          <div key={e.id} className={`sl-team-pop-row ${on ? "is-on" : ""} ${isOwner ? "is-owner" : ""}`}>
                            <button type="button" className="sl-team-pop-main" onClick={() => canAssign && toggleMember(e.id)} disabled={!canAssign}>
                              <span className="sl-team-pop-check">{on && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>}</span>
                              <span className="sl-team-pop-av">{(e.name || "?").slice(0, 1).toUpperCase()}</span>
                              <span className="sl-team-pop-name">{e.name}</span>
                              {isOwner && <span className="sl-team-pop-owner-tag">Owner</span>}
                            </button>
                            <button type="button" className={`sl-team-pop-star ${isOwner ? "is-owner" : ""}`}
                              onClick={() => canAssign && toggleOwner(e.id)} disabled={!canAssign}
                              title={isOwner ? "Remove as owner" : "Make owner"} aria-label={isOwner ? "Remove as owner" : "Make owner"}>
                              <svg viewBox="0 0 24 24" fill={isOwner ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l3 6.5 7 .6-5.3 4.6 1.6 6.9L12 17.8 5.7 20.6l1.6-6.9L2 9.1l7-.6z" /></svg>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <p className="sl-team-pop-hint">Tap the star to set who owns the deal.</p>
                  {!canAssign && <p className="sl-team-pop-note">Only boss and sales managers can change this.</p>}
                </div>
              </>
            )}
          </div>
          <button className="sl-d-del" onClick={remove}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
          </button>
        </div>
      </header>

      <div className="sl-scroll">
        {/* Pipeline flow — hero */}
        <div className={`sl-pipe sl-pipe-${status}`}>
          <div className="sl-pipe-body">
            <div className="sl-pipe-stat">
              <span className="sl-pipe-pct">{pct}<i>%</i></span>
              {closeProb != null && (
                <span className={`sl-pipe-prob sl-pipe-prob-${probTone}`} title="Chance this deal closes, based on the current phase">
                  <span className="sl-pipe-prob-dot" />
                  {closeProb}% close
                </span>
              )}
            </div>
            <div className="sl-flow">
              {phases.length === 0 ? <span className="sl-pipe-empty">This pipeline has no phases.</span> : phases.map((p, i) => {
                const entered = phaseEnteredAt(p.id);
              const state = i < curIdx ? "done" : i === curIdx ? "cur" : "future";
              return (
                <div key={p.id} className="sl-flow-item">
                  {i > 0 && <div className={`sl-flow-bar ${i <= curIdx ? "is-on" : ""}`} />}
                  <button className={`sl-flow-node is-${state} ${p.sales_outcome ? `oc-${p.sales_outcome}` : ""}`} onClick={() => applyPhase(p.id)}>
                    <span className="sl-flow-num">{p.sales_outcome === "win" ? "★" : p.sales_outcome === "loss" ? "✕" : state === "done" ? "✓" : i + 1}</span>
                    <span className="sl-flow-text">
                      <span className="sl-flow-name">{p.name}</span>
                      <span className="sl-flow-date">{entered ? fmtDate(entered) : "—"}</span>
                    </span>
                  </button>
                </div>
              );
            })}
            </div>
          </div>
        </div>

        {/* Four columns */}
        <div className="sl-work">
          <div className="sl-col-left">
          <section className="sl-panel sl-panel-compact sl-panel-notes">
            <div className="sl-note-head">
              <h3 className="sl-panel-title">Notes<span>{notes.length}</span></h3>
              {notes.length > 0 && (
                <button className="sl-see-icon" onClick={() => setItemsModal("notes")} title={`See all ${notes.length} notes`} aria-label="See all notes">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
                </button>
              )}
            </div>
            <div className={`sl-note-add sl-note-add-fluid ${cleanMentions(newNote).trim() ? "is-writing" : ""}`}>
              <MentionInput multiline value={newNote} onChange={setNewNote} people={mentionPeople}
                onMention={() => {}} placeholder="Write a note... use @ to mention" />
              <button className="sl-add-btn sl-add-btn-inline" onClick={submitNote} disabled={!cleanMentions(newNote).trim()}>Add</button>
            </div>
          </section>

          <section className="sl-panel sl-panel-compact sl-panel-notes">
            <div className="sl-note-head">
              <h3 className="sl-panel-title sl-tasks-title">Tasks
                <span className="sl-tcount sl-tcount-todo" title="To do">{tasks.filter((t) => !t.done).length}</span>
                <span className="sl-tcount sl-tcount-done" title="Completed">{tasks.filter((t) => t.done).length} ✓</span>
                {overdueCount > 0 && <span className="sl-tcount sl-tcount-late" title="Overdue">{overdueCount} late</span>}
              </h3>
              {tasks.length > 0 && (
                <button className="sl-see-icon" onClick={() => setItemsModal("tasks")} title={`See all ${tasks.length} tasks`} aria-label="See all tasks">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
                </button>
              )}
            </div>
            <div className="sl-task-add">
              <MentionInput multiline value={newTask} onChange={setNewTask} people={mentionPeople}
                onMention={() => {}} placeholder="Add a task... use @ to mention" />
              <div className={`sl-meet-reveal ${cleanMentions(newTask).trim() ? "is-writing" : ""}`}>
                <div className="sl-task-due">
                  <span className="sl-task-due-lbl">Due</span>
                  <DatePicker value={taskDue} onChange={setTaskDue} placeholder="Date" />
                  <TimePicker value={taskDueTime} onChange={setTaskDueTime} />
                </div>
                <button className="sl-add-btn sl-meet-schedule" onClick={submitTask} disabled={!cleanMentions(newTask).trim() || !taskDue}>Add task</button>
              </div>
            </div>
          </section>

          <section className="sl-panel sl-panel-compact sl-panel-notes">
            <div className="sl-note-head">
              <h3 className="sl-panel-title">Meetings<span>{meetings.length}</span></h3>
              {meetings.length > 0 && (
                <button className="sl-see-icon" onClick={() => setItemsModal("meetings")} title={`See all ${meetings.length} meetings`} aria-label="See all meetings">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
                </button>
              )}
            </div>
            <div className="sl-meet-add">
              <MentionInput multiline value={meetTitle} onChange={setMeetTitle} people={mentionPeople}
                onMention={() => {}} placeholder="Meeting title... use @ to mention" />
              <div className={`sl-meet-reveal ${cleanMentions(meetTitle).trim() ? "is-writing" : ""}`}>
                <div className="sl-meet-when">
                  <DatePicker value={meetDate} onChange={setMeetDate} placeholder="Date" />
                  <TimePicker value={meetTime} onChange={setMeetTime} />
                  <div className="sl-meet-kinds sl-meet-kinds-new">
                    {MEETING_KINDS.map((k) => (
                      <button key={k.value} className={meetKind === k.value ? "is-on" : ""} title={k.label}
                        aria-label={k.label} onClick={() => setMeetKind(k.value)}>{k.icon}</button>
                    ))}
                  </div>
                </div>
                <button className="sl-add-btn sl-meet-schedule" onClick={submitMeeting} disabled={!cleanMentions(meetTitle).trim() || !meetDate}>Schedule</button>
              </div>
            </div>
          </section>
          </div>

          <div className="sl-col-right">
          <section className="sl-panel sl-panel-docs">
            <TrackingFiles trackingId={tracking.id} phaseId={curPhase} phases={phases} />
          </section>

          <section className="sl-panel sl-prob-panel">
            <h3 className="sl-panel-title">Close probability</h3>

            <div className="sl-probfield">
              <span className="sl-probfield-k">Sales estimate</span>
              <div className="sl-probfield-row">
                <input
                  className="sl-probfield-range"
                  type="range" min={0} max={100} step={5}
                  value={repProb ?? 0}
                  onChange={(e) => { const v = Number(e.target.value); setRepProb(v); saveProb("rep", v); }}
                />
                <span className="sl-probfield-v">{repProb == null ? "—" : `${repProb}%`}</span>
                <span className="sl-probfield-datewrap">
                  <DatePicker value={repDate} placeholder="+ date"
                    onChange={(v) => { setRepDate(v); setDealCloseDate(tracking.id, "rep", v || null).catch(() => {}); }} />
                </span>
              </div>
            </div>

            <div className={`sl-probfield sl-probfield-mgr ${canAssign ? "" : "is-locked"}`}>
              <span className="sl-probfield-k">
                Management estimate
                {!canAssign && (
                  <svg className="sl-probfield-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
                )}
              </span>
              <div className="sl-probfield-row">
                {canAssign ? (
                  <input
                    className="sl-probfield-range"
                    type="range" min={0} max={100} step={5}
                    value={mgrProb ?? 0}
                    onChange={(e) => { const v = Number(e.target.value); setMgrProb(v); saveProb("mgr", v); }}
                  />
                ) : (
                  <div className="sl-probfield-track">
                    <span className="sl-probfield-fill" style={{ width: `${mgrProb ?? 0}%` }} />
                  </div>
                )}
                <span className="sl-probfield-v">{mgrProb == null ? "—" : `${mgrProb}%`}</span>
                <span className="sl-probfield-datewrap">
                  {canAssign ? (
                    <DatePicker value={mgrDate} placeholder="+ date"
                      onChange={(v) => { setMgrDate(v); setDealCloseDate(tracking.id, "mgr", v || null).catch(() => {}); }} />
                  ) : (
                    <span className="sl-probfield-date-ro">{mgrDate ? new Date(mgrDate).toLocaleDateString() : "—"}</span>
                  )}
                </span>
              </div>
            </div>
          </section>
          </div>

          <div className="sl-col-calc">
          <section className="sl-panel sl-panel-calc">
            <div className="sl-calc-head-row">
              <h3 className="sl-panel-title">Potential revenue</h3>
              <span className="sl-calc-headtotal">{money(totalPotential)}</span>
            </div>

            {tprods.length === 0 && potentials.length === 0 && (
              <p className="sl-hint">No products or services yet.</p>
            )}

            <div className="sl-calc-cards">
              {activeTprods.map((tp) => {
                const vg = tp.version_group ?? tp.id;
                const grp = groupOf(tprods, vg);
                const idx = grp.findIndex((x) => x.id === tp.id);
                return (
                  <RevLine key={vg} name={productName(tp.product_id)} tag="Product" line={tp} money={money}
                    onRemove={() => removeProduct(tp.id)}
                    calculator={productOf(tp.product_id)?.calculator as Calculator | null}
                    catalogBase={productOf(tp.product_id)?.tiers?.find((x) => x.id === tp.tier_id)?.price}
                    onOpenCalc={() => setCalcFor({ kind: "product", id: tp.id })}
                    versionIdx={idx} versionCount={grp.length}
                    onPrev={idx > 0 ? () => switchProdVersion(vg, grp[idx - 1].id) : undefined}
                    onNext={idx < grp.length - 1 ? () => switchProdVersion(vg, grp[idx + 1].id) : undefined}
                    onNewVersion={(copy) => newProdVersion(tp.id, copy)} />
                );
              })}
              {activePotentials.map((p) => {
                const vg = p.version_group ?? p.id;
                const grp = groupOf(potentials, vg);
                const idx = grp.findIndex((x) => x.id === p.id);
                return (
                  <RevLine key={vg} name={p.label || serviceName(p.service_id)} tag="Service" tagClass="sl-rev-tag-svc"
                    line={p} money={money} unit={serviceUnit(p.service_id)} minUnit={serviceMin(p.service_id)}
                    onRemove={() => removePotential(p.id)}
                    calculator={serviceOf(p.service_id)?.calculator as Calculator | null}
                    onOpenCalc={() => setCalcFor({ kind: "service", id: p.id })}
                    versionIdx={idx} versionCount={grp.length}
                    onPrev={idx > 0 ? () => switchSvcVersion(vg, grp[idx - 1].id) : undefined}
                    onNext={idx < grp.length - 1 ? () => switchSvcVersion(vg, grp[idx + 1].id) : undefined}
                    onNewVersion={(copy) => newSvcVersion(p.id, copy)} />
                );
              })}
            </div>

            <div className="sl-calc-adds">
              {availableProducts.length > 0 && (
                <Select value="" onChange={(v) => v && addProduct(v)} placeholder="+ Add product" options={availableProducts.map((p) => ({ value: p.id!, label: p.name }))} />
              )}
              {services.length > 0 && (
                <Select value="" onChange={(v) => v && addPotential(v)} placeholder="+ Add potential service" options={services.map((s) => ({ value: s.id!, label: s.name }))} />
              )}
            </div>

            {revErr && <p className="sl-rev-err">Could not save: {revErr}</p>}
            <div className="sl-calc-foot sl-calc-foot-actions" onMouseLeave={() => setPropMenu(false)}>
              <span>Total if won</span>
              <div className="sl-prop-wrap">
                <button className={`sl-prop-btn ${propBusy ? "is-busy" : ""}`} onClick={() => setPropMenu((v) => !v)} disabled={!!propBusy} title="Generate proposal">
                  {propBusy ? (
                    <span className="sl-prop-spin" />
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M12 18v-6M9 15l3 3 3-3" /></svg>
                  )}
                  <span>{propBusy ? "Generating…" : "Proposal"}</span>
                </button>
                {propMenu && (
                  <div className="sl-prop-menu">
                    <button onClick={() => runProposal("pptx")}>
                      <b>PowerPoint deck</b><i>Commercial presentation, ready to send</i>
                    </button>
                    <button onClick={() => runProposal("pdf")}>
                      <b>PDF order form</b><i>Scope, prices and signatures</i>
                    </button>
                  </div>
                )}
              </div>
              <b>{money(totalPotential)}</b>
            </div>
            {propErr && <p className="sl-rev-err">{propErr}</p>}
          </section>
          </div>
        </div>
      </div>

      {calcFor && (() => {
        if (calcFor.kind === "product") {
          const tp = tprods.find((x) => x.id === calcFor.id);
          if (!tp) return null;
          const prod = productOf(tp.product_id);
          return (
            <LineCalcModal
              title={prod?.name ?? "Product"}
              line={tp}
              tiers={prod?.tiers}
              calculator={prod?.calculator as Calculator | null}
              money={money}
              onApply={(patch) => patchProduct(tp.id, patch)}
              onClose={() => setCalcFor(null)}
            />
          );
        }
        const ps = potentials.find((x) => x.id === calcFor.id);
        if (!ps) return null;
        const svc = serviceOf(ps.service_id);
        return (
          <LineCalcModal
            title={ps.label || svc?.name || "Service"}
            line={ps}
            roles={svc?.roles}
            calculator={svc?.calculator as Calculator | null}
            unit={svc?.rate_unit ?? "day"}
            minUnit={serviceMin(ps.service_id)}
            money={money}
            onApply={(patch) => patchPotential(ps.id, patch)}
            onClose={() => setCalcFor(null)}
          />
        );
      })()}

      {clientFormOpen && clientPrefill && (
        <HandoffClientForm
          prefill={clientPrefill}
          catalog={clientCatalog}
          mode={clientFormMode}
          onClose={() => { setClientFormOpen(false); setPendingHandoff(null); setClientPrefill(null); setAttachClientId(null); setClientFormMode("create"); }}
          onConfirm={clientFormMode === "attach" ? attachClientAndHandoff : saveClientAndHandoff}
        />
      )}

      {confirmOpen && confirmClient && (
        <HandoffConfirmServices
          clientName={company?.name ?? "this client"}
          skipPrompt={confirmSkipPrompt}
          client={confirmClient}
          services={confirmServices}
          money={money}
          onClose={() => { setConfirmOpen(false); setPendingHandoff(null); }}
          onConfirm={async ({ services, mode, client, paymentDays }) => {
            // Client-level edits: legal, address, payment (NOT contacts — those are
            // per-service now and live on the service rows + tracking_contacts).
            if (tracking.company_id && (mode === "update" || client)) {
              await supabase.from("clients").update({
                legal_name: client.legalName || null, vat_number: client.vatNumber || null,
                address: client.address, payment_days: paymentDays,
              }).eq("company_id", tracking.company_id);
            }
            // Create any brand-new contacts on the company; capture their real ids.
            let created: { localId: string; id: string }[] = [];
            if (tracking.company_id) {
              created = await syncNewContactsToCompany(tracking.company_id, client.contacts).catch(() => []) as any;
            }
            // A service's contactIds are "keys": a real id for existing contacts,
            // a local id for new ones. Map keys -> real contact ids.
            const toRealId = (k: string) => created.find((n) => n.localId === k)?.id ?? k;
            const byKey = (k: string) => client.contacts.find((c) => (c.sourceId ?? c.id) === k);

            const dealContactIds = new Set<string>();
            for (const s of services) {
              const realIds = ((s as any).contactIds ?? []).map(toRealId).filter(Boolean) as string[];
              realIds.forEach((id) => dealContactIds.add(id));
              const bc = byKey((s as any).billingContactId);
              await updatePotentialServiceTerm(s.key, {
                price: (s.line as any).price, quantity: (s.line as any).quantity,
                recurring: (s.line as any).recurring, period: (s.line as any).period,
                term_years: (s.line as any).term_years, tier_id: (s.line as any).tier_id ?? null,
                calc_values: (s.line as any).calc_values, calc_discounts: (s.line as any).calc_discounts,
                calc_rates: (s.line as any).calc_rates, discount_mode: (s.line as any).discount_mode,
                discount_value: (s.line as any).discount_value,
                contact_ids: realIds,
                billing_contact_name: bc?.name ?? null, billing_contact_email: bc?.email ?? null,
              } as any).catch(() => {});
            }
            // The deal's contacts = the union of every service's contacts.
            const unionIds = Array.from(dealContactIds);
            await setTrackingContacts(tracking.id, unionIds).catch(() => {});
            setTrackingContactIds(unionIds);

            setConfirmOpen(false);
            if (pendingHandoff) { await sendHandoff(pendingHandoff); setPendingHandoff(null); }
          }}
        />
      )}

      {phaseEditor && (
        <PhaseEditor
          services={phaseEditor.services}
          onClose={() => setPhaseEditor(null)}
          onConfirm={(override) => { const sel = phaseEditor.sel; setPhaseEditor(null); generateWithSel("pptx", sel, override); }}
          onSkip={() => { const sel = phaseEditor.sel; setPhaseEditor(null); generateWithSel("pptx", sel); }}
        />
      )}

      {propPick && (
        <ProposalPicker
          kind={propPick}
          groups={[
            ...Array.from(new Set(tprods.map((p) => p.version_group ?? p.id))).map((vg) => {
              const grp = groupOf(tprods, vg as string);
              const active = activeOfGroup(tprods, vg as string);
              return { key: `p:${vg}`, tag: "Product", name: productName(active?.product_id ?? null),
                versions: grp.map((v, i) => ({ id: v.id, label: `v${i + 1}`, amount: lineBreakdown(v, productOf(v.product_id)?.calculator as Calculator | null, productOf(v.product_id)?.tiers?.find((x: any) => x.id === v.tier_id)?.price).total })),
                activeId: active?.id ?? grp[0]?.id };
            }),
            ...Array.from(new Set(potentials.map((p) => p.version_group ?? p.id))).map((vg) => {
              const grp = groupOf(potentials, vg as string);
              const active = activeOfGroup(potentials, vg as string);
              return { key: `s:${vg}`, tag: "Service", name: (active?.label || serviceName(active?.service_id ?? null)),
                versions: grp.map((v, i) => ({ id: v.id, label: `v${i + 1}`, amount: lineBreakdown(v, serviceOf(v.service_id)?.calculator as Calculator | null, undefined, serviceMin(v.service_id)).total })),
                activeId: active?.id ?? grp[0]?.id };
            }),
          ]}
          money={money}
          onClose={() => setPropPick(null)}
          onConfirm={(sel) => doGenerate(propPick, sel)}
        />
      )}

      {lossModal && (
        <LossReasonModal
          reasons={lossReasons}
          reason={lossReason} details={lossDetails}
          onReasons={async () => setLossReasons(await listLossReasons().catch(() => []))}
          onSave={async (r, d) => {
            setLossReasonState(r); setLossDetails(d);
            await setLossReason(tracking.id, r || null, d || null).catch(() => {});
            setLossModal(false);
          }}
          onClose={() => setLossModal(false)}
        />
      )}

      {confirmDlg && (
        <div className="sl-cf-backdrop" onMouseDown={() => setConfirmDlg(null)}>
          <div className="sl-cf" onMouseDown={(e) => e.stopPropagation()} role="alertdialog" aria-modal="true">
            <div className="sl-cf-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
            </div>
            <h3 className="sl-cf-title">{confirmDlg.title}</h3>
            <p className="sl-cf-msg">{confirmDlg.message}</p>
            <div className="sl-cf-actions">
              <button className="sl-cf-cancel" onClick={() => setConfirmDlg(null)}>Cancel</button>
              <button className="sl-cf-confirm" onClick={() => { const fn = confirmDlg.onConfirm; setConfirmDlg(null); fn(); }}>{confirmDlg.confirmLabel ?? "Delete"}</button>
            </div>
          </div>
        </div>
      )}

      {itemsModal && (
        <ItemsModal
          kind={itemsModal}
          phases={phases}
          onClose={() => setItemsModal(null)}
          notes={notes} tasks={tasks} meetings={meetings}
          people={mentionPeople} fmtMeet={fmtMeet}
          onEditNote={editNote} onDeleteNote={removeNote}
          onFlipTask={flipTask} onEditTask={editTask} onDeleteTask={removeTask}
          onEditMeeting={editMeeting} onKindMeeting={setMeetingKind} onDeleteMeeting={removeMeeting}
          MiniAssignees={MiniAssignees} AssigneeArea={AssigneeArea}
        />
      )}
    </div>
  );
}
// ============================ Note item (expand/collapse + inline edit) ============================
function NoteItem({ note, people, onEdit, onDelete, tagged, children }: {
  people: MentionPerson[];
  note: TrackNote;
  onEdit: (id: string, body: string) => void | Promise<void>;
  onDelete: (id: string) => void;
  tagged?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);
  const [overflowing, setOverflowing] = useState(false);
  const pRef = useRef<HTMLParagraphElement>(null);

  // Detect whether the collapsed text is clipped (so we only show the toggle when needed).
  useEffect(() => {
    const el = pRef.current;
    if (el && !editing) setOverflowing(el.scrollHeight > el.clientHeight + 2);
  }, [note.body, editing, expanded]);

  const save = async () => {
    const body = draft.trim();
    if (body && body !== note.body) await onEdit(note.id, body);
    setEditing(false);
  };
  const cancel = () => { setDraft(note.body); setEditing(false); };

  if (editing) {
    return (
      <div className="sl-note sl-note-editing">
        <MentionInput multiline value={draft} onChange={setDraft} people={people} placeholder="Edit note. Type @ to tag someone" />
        <div className="sl-note-edit-actions">
          <button className="sl-note-cancel" onClick={cancel}>Cancel</button>
          <button className="sl-note-save" onClick={save} disabled={!draft.trim()}>Save</button>
        </div>
      </div>
    );
  }

  return (
    <div className="sl-note">
      <div className="sl-note-tools">
        {tagged}
        <button className="sl-note-edit-btn" onClick={() => { setDraft(note.body); setEditing(true); }} aria-label="Edit">✎</button>
        <button className="sl-note-x" onClick={() => onDelete(note.id)} aria-label="Delete">×</button>
      </div>
      <p
        ref={pRef}
        className={`sl-note-body ${expanded ? "is-expanded" : "is-clamped"}`}
        onClick={() => (overflowing || expanded) && setExpanded((v) => !v)}
        style={{ cursor: (overflowing || expanded) ? "pointer" : "default" }}
      >
        {cleanMentionsFn(note.body)}
      </p>
      {(overflowing || expanded) && (
        <button className="sl-note-more" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
      {children}
    </div>
  );
}

// ============================ Task item (one line, check, inline edit) ============================
function TaskItem({ task, people, overdue, onToggle, onEdit, onDelete, tagged }: {
  people: MentionPerson[];
  task: TrackTask;
  overdue?: boolean;
  onToggle: (t: TrackTask) => void;
  onEdit: (id: string, title: string) => void | Promise<void>;
  onDelete: (id: string) => void;
  tagged?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Clicking anywhere outside folds the task back to one line.
  useEffect(() => {
    if (!expanded) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setExpanded(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [expanded]);
  const save = async () => { const v = draft.trim(); if (v && v !== task.title) await onEdit(task.id, v); setEditing(false); };
  const cancel = () => { setDraft(task.title); setEditing(false); };

  if (editing) {
    return (
      <div className="sl-task sl-task-editing">
        <MentionInput multiline value={draft} onChange={setDraft} people={people} placeholder="Edit task. Type @ to tag someone" />
        <div className="sl-inline-actions">
          <button className="sl-note-cancel" onClick={cancel}>Cancel</button>
          <button className="sl-note-save" onClick={save} disabled={!draft.trim()}>Save</button>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className={`sl-task ${task.done ? "is-done" : ""} ${expanded ? "is-expanded" : ""} ${overdue ? "is-overdue" : ""}`}>
      <button className="sl-check" onClick={() => onToggle(task)} aria-label="Toggle">{task.done && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
      )}</button>
      <span className="sl-task-title" onClick={() => setExpanded((v) => !v)}
        title={expanded ? "" : cleanMentionsFn(task.title)}>{cleanMentionsFn(task.title)}</span>
      {task.due_at && (
        <span className={`sl-task-due-chip ${overdue ? "is-late" : ""}`} title={overdue ? "Overdue" : "Due"}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
          {new Date(task.due_at).toLocaleDateString(undefined, { day: "2-digit", month: "short" })} {new Date(task.due_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
        </span>
      )}
      {tagged}
      <button className="sl-note-edit-btn sl-inline-edit-btn" onClick={() => { setDraft(task.title); setEditing(true); }} aria-label="Edit">✎</button>
      <button className="sl-task-x sl-inline-x" onClick={() => onDelete(task.id)} aria-label="Delete">×</button>
    </div>
  );
}

// ============================ Meeting item (date/time left, title clamp+expand, edit) ============================
function MeetingItem({ meeting, people, fmtMeet, onEdit, onDelete, onKind, tagged }: {
  people: MentionPerson[];
  onKind: (id: string, kind: MeetingKind) => void;
  meeting: TrackMeeting;
  fmtMeet: (iso: string | null) => string;
  onEdit: (id: string, title: string) => void | Promise<void>;
  onDelete: (id: string) => void;
  tagged?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(meeting.title);
  const [overflowing, setOverflowing] = useState(false);
  const pRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const el = pRef.current;
    if (el && !editing) setOverflowing(el.scrollHeight > el.clientHeight + 2);
  }, [meeting.title, editing, expanded]);

  const save = async () => { const v = draft.trim(); if (v && v !== meeting.title) await onEdit(meeting.id, v); setEditing(false); };
  const cancel = () => { setDraft(meeting.title); setEditing(false); };

  // fmtMeet gives "12 Aug, 10:00"; split date and time for the left block.
  const at = fmtMeet(meeting.meet_at);
  const [datePart, timePart] = at.includes(",") ? at.split(",").map((s) => s.trim()) : [at, ""];

  const past = !!meeting.meet_at && new Date(meeting.meet_at).getTime() < Date.now();
  const kind = (meeting.kind ?? "in_person") as MeetingKind;

  return (
    <div className={`sl-meeting ${past ? "is-past" : ""}`}>
      <div className="sl-meet-when-block">
        <span className="sl-meet-date">{datePart}</span>
        {timePart && <span className="sl-meet-time">{timePart}</span>}
        {past && <span className="sl-meet-past">done</span>}
      </div>
      <div className="sl-meet-content">
        {editing ? (
          <div className="sl-meet-edit">
            <MentionInput multiline value={draft} onChange={setDraft} people={people} placeholder="Edit meeting. Type @ to tag someone" />
            <div className="sl-inline-actions">
              <button className="sl-note-cancel" onClick={cancel}>Cancel</button>
              <button className="sl-note-save" onClick={save} disabled={!draft.trim()}>Save</button>
            </div>
          </div>
        ) : (
          <>
            <div className="sl-meet-tools">
              <div className="sl-meet-kinds">
                {MEETING_KINDS.map((k) => (
                  <button key={k.value} className={kind === k.value ? "is-on" : ""} title={k.label}
                    aria-label={k.label} onClick={() => onKind(meeting.id, k.value)}>{k.icon}</button>
                ))}
              </div>
              {tagged}
              <button className="sl-note-edit-btn" onClick={() => { setDraft(meeting.title); setEditing(true); }} aria-label="Edit">✎</button>
              <button className="sl-note-x" onClick={() => onDelete(meeting.id)} aria-label="Delete">×</button>
            </div>
            <p ref={pRef}
              className={`sl-meet-title-body ${expanded ? "is-expanded" : "is-clamped"}`}
              onClick={() => (overflowing || expanded) && setExpanded((v) => !v)}
              style={{ cursor: (overflowing || expanded) ? "pointer" : "default" }}
            >{cleanMentionsFn(meeting.title)}</p>
            {(overflowing || expanded) && (
              <button className="sl-note-more" onClick={() => setExpanded((v) => !v)}>{expanded ? "Show less" : "Show more"}</button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
// ============================ Items modal (all notes / tasks / meetings) ============================
function ItemsModal({ kind, phases, onClose, notes, tasks, meetings, people, fmtMeet,
  onEditNote, onDeleteNote, onFlipTask, onEditTask, onDeleteTask,
  onEditMeeting, onKindMeeting, onDeleteMeeting, MiniAssignees, AssigneeArea }: any) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title = kind === "notes" ? "All notes" : kind === "tasks" ? "All tasks" : "All meetings";

  const [q, setQ] = useState("");
  const [sort, setSort] = useState("recent");
  const [fPhase, setFPhase] = useState("");
  const [fStatus, setFStatus] = useState("all"); // tasks: all | todo | done | overdue
  const taskOverdue = (t: any) => !t.done && !!t.due_at && new Date(t.due_at).getTime() < Date.now();
  const phaseName = (id: string | null) => (phases ?? []).find((p: any) => p.id === id)?.name ?? "No phase";
  const norm = (s: string) => (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const clean = (s: string) => (s ?? "").replace(/@\[([^\]]+)\]\([^)]+\)/g, "@$1");
  const textOf = (it: any) => kind === "notes" ? it.body : it.title;
  const dateOf = (it: any) => kind === "meetings" ? (it.meet_at || it.created_at || "") : (it.created_at || "");

  const source: any[] = kind === "notes" ? notes : kind === "tasks" ? tasks : meetings;
  const phaseIds = Array.from(new Set(source.map((it) => it.phase_id).filter(Boolean))) as string[];
  const shown = source
    .filter((it) => { const n = norm(q.trim()); return !n || norm(clean(textOf(it))).includes(n); })
    .filter((it) => !fPhase || it.phase_id === fPhase)
    .filter((it) => {
      if (kind !== "tasks" || fStatus === "all") return true;
      if (fStatus === "todo") return !it.done;
      if (fStatus === "done") return it.done;
      if (fStatus === "overdue") return taskOverdue(it);
      return true;
    })
    .sort((a, b) => {
      if (sort === "due" && kind === "tasks") {
        const av = a.due_at || "9999", bv = b.due_at || "9999";
        return String(av).localeCompare(String(bv));
      }
      if (sort === "name") return norm(clean(textOf(a))).localeCompare(norm(clean(textOf(b))));
      const cmp = String(dateOf(a)).localeCompare(String(dateOf(b)));
      return sort === "old" ? cmp : -cmp;
    });
  const count = shown.length;

  return (
    <div className="sl-im-backdrop" onMouseDown={onClose}>
      <div className="sl-im" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="sl-im-head">
          <h3 className="sl-im-title">{title}<span>{count}</span></h3>
          <button className="sl-im-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="sl-im-toolbar">
          <div className="sl-im-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${kind}…`} />
            {q && <button className="sl-im-search-x" onClick={() => setQ("")} aria-label="Clear">×</button>}
          </div>
          <div className="sl-im-sort">
            <Select value={sort} onChange={setSort}
              options={[
                { value: "recent", label: "Newest" }, { value: "old", label: "Oldest" }, { value: "name", label: "Name A–Z" },
                ...(kind === "tasks" ? [{ value: "due", label: "Due date" }] : []),
              ]} />
          </div>
          {phaseIds.length > 1 && (
            <div className="sl-im-sort">
              <Select value={fPhase} onChange={setFPhase}
                options={[{ value: "", label: "All phases" }, ...phaseIds.map((id) => ({ value: id, label: phaseName(id) }))]} />
            </div>
          )}
        </div>
        {kind === "tasks" && (
          <div className="sl-im-statusrow">
            {[
              { v: "all", l: "All" }, { v: "todo", l: "To do" }, { v: "done", l: "Done" }, { v: "overdue", l: "Overdue" },
            ].map((s) => (
              <button key={s.v} className={`sl-im-statusbtn ${fStatus === s.v ? "is-on" : ""} ${s.v === "overdue" ? "is-late" : ""}`} onClick={() => setFStatus(s.v)}>
                {s.l}{s.v === "overdue" && tasks.filter(taskOverdue).length > 0 ? ` (${tasks.filter(taskOverdue).length})` : ""}
              </button>
            ))}
          </div>
        )}
        <div className="sl-im-body">
          {shown.length === 0 ? (
            <p className="sl-hint">{q ? `No ${kind} match your search.` : `No ${kind} yet.`}</p>
          ) : kind === "notes" ? (
            <div className="sl-notes">
              {shown.map((n: any) => (
                <NoteItem key={n.id} note={n} people={people} onEdit={onEditNote} onDelete={onDeleteNote} tagged={<MiniAssignees itemId={n.id} compact />}>
                  <AssigneeArea itemId={n.id} />
                </NoteItem>
              ))}
            </div>
          ) : kind === "tasks" ? (
            <div className="sl-tasks">
              {shown.map((t: any) => (
                <TaskItem key={t.id} task={t} people={people} overdue={!t.done && !!t.due_at && new Date(t.due_at).getTime() < Date.now()} onToggle={onFlipTask} onEdit={onEditTask} onDelete={onDeleteTask} tagged={<MiniAssignees itemId={t.id} compact />} />
              ))}
            </div>
          ) : (
            <div className="sl-meetings">
              {shown.map((m: any) => (
                <MeetingItem key={m.id} meeting={m} people={people} fmtMeet={fmtMeet} onEdit={onEditMeeting} onKind={onKindMeeting} onDelete={onDeleteMeeting} tagged={<MiniAssignees itemId={m.id} compact />} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================ Loss reason modal ============================
function LossReasonModal({ reasons, reason, details, onReasons, onSave, onClose }: {
  reasons: LossReason[];
  reason: string; details: string;
  onReasons: () => void | Promise<void>;
  onSave: (reason: string, details: string) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState(reason);
  const [text, setText] = useState(details);
  const [manage, setManage] = useState(false);
  const [items, setItems] = useState<LossReason[]>(reasons);
  const [newLabel, setNewLabel] = useState("");
  const [q, setQ] = useState("");
  const norm = (s: string) => (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const filtered = items.filter((r) => { const n = norm(q.trim()); return !n || norm(r.label).includes(n); });
  useEffect(() => { setItems(reasons); }, [reasons]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const refresh = async () => { await onReasons(); setItems(await listLossReasons().catch(() => [])); };
  const add = async () => { if (!newLabel.trim()) return; await addLossReason(newLabel.trim(), items.length); setNewLabel(""); await refresh(); };
  const rename = async (id: string, label: string) => { if (label.trim()) await updateLossReason(id, label.trim()); await refresh(); };
  const remove = async (id: string) => { await deleteLossReason(id); await refresh(); };

  return (
    <div className="sl-loss-backdrop" onMouseDown={onClose}>
      <div className="sl-loss" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="sl-loss-head">
          <div>
            <span className="sl-loss-eyebrow">Deal lost</span>
            <h3 className="sl-loss-title">Why was it lost?</h3>
          </div>
          <button className="sl-loss-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        {manage ? (
          <div className="sl-loss-body">
            <p className="sl-loss-manage-hint">Edit the reasons everyone can pick from.</p>
            <div className="sl-loss-manage-list">
              {items.map((r) => (
                <div className="sl-loss-manage-row" key={r.id}>
                  <input defaultValue={r.label} onBlur={(e) => e.target.value.trim() !== r.label && rename(r.id, e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
                  <button className="sl-loss-manage-del" onClick={() => remove(r.id)} aria-label="Delete">×</button>
                </div>
              ))}
            </div>
            <div className="sl-loss-manage-add">
              <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="New reason…"
                onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
              <button className="sl-loss-manage-addbtn" onClick={add} disabled={!newLabel.trim()}>+ Add</button>
            </div>
            <div className="sl-loss-foot">
              <button className="sl-loss-back" onClick={() => setManage(false)}>← Back</button>
            </div>
          </div>
        ) : (
          <div className="sl-loss-body">
            {items.length > 0 && (
              <div className="sl-loss-search">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search reasons…" />
                {q && <button className="sl-loss-search-x" onClick={() => setQ("")} aria-label="Clear">×</button>}
              </div>
            )}
            <div className="sl-loss-reasons">
              {items.length === 0 ? (
                <p className="sl-loss-empty">No reasons yet — add some with “Manage”.</p>
              ) : filtered.length === 0 ? (
                <p className="sl-loss-empty">No reasons match “{q}”.</p>
              ) : filtered.map((r) => (
                <button key={r.id} className={`sl-loss-chip ${picked === r.label ? "is-on" : ""}`} onClick={() => setPicked(picked === r.label ? "" : r.label)}>
                  {r.label}
                </button>
              ))}
            </div>
            <button className="sl-loss-managebtn" onClick={() => setManage(true)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>
              Manage reasons
            </button>
            <label className="sl-loss-detlbl">More details (optional)</label>
            <textarea className="sl-loss-details" value={text} onChange={(e) => setText(e.target.value)} placeholder="Anything worth noting about why this deal was lost…" />
            <div className="sl-loss-foot">
              <button className="sl-loss-skip" onClick={() => onSave("", "")}>Skip</button>
              <button className="sl-loss-save" onClick={() => onSave(picked, text)}>Save</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================ Proposal picker (lines + versions) ============================
function ProposalPicker({ kind, groups, money, onClose, onConfirm }: {
  kind: "pptx" | "pdf";
  groups: { key: string; tag: string; name: string; versions: { id: string; label: string; amount: number }[]; activeId: string }[];
  money: (n: number) => string;
  onClose: () => void;
  onConfirm: (sel: Record<string, { include: boolean; versionId: string }>) => void;
}) {
  const [sel, setSel] = useState<Record<string, { include: boolean; versionId: string }>>(() => {
    const o: Record<string, { include: boolean; versionId: string }> = {};
    groups.forEach((g) => { o[g.key] = { include: true, versionId: g.activeId }; });
    return o;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const total = groups.reduce((s, g) => {
    const st = sel[g.key];
    if (!st?.include) return s;
    const v = g.versions.find((x) => x.id === st.versionId) ?? g.versions[0];
    return s + (v?.amount ?? 0);
  }, 0);
  const anyIncluded = groups.some((g) => sel[g.key]?.include);
  const label = kind === "pptx" ? "PowerPoint deck" : "PDF order form";

  return (
    <div className="sl-pp-backdrop" onMouseDown={onClose}>
      <div className="sl-pp" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="sl-pp-head">
          <div>
            <span className="sl-pp-eyebrow">{label}</span>
            <h3 className="sl-pp-title">What goes in the proposal?</h3>
          </div>
          <button className="sl-pp-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="sl-pp-body">
          {groups.length === 0 ? (
            <p className="sl-hint">This deal has no products or services yet.</p>
          ) : groups.map((g) => {
            const st = sel[g.key];
            return (
              <div key={g.key} className={`sl-pp-row ${st?.include ? "is-on" : "is-off"}`}>
                <button className="sl-pp-rowtop" onClick={() => setSel((x) => ({ ...x, [g.key]: { ...x[g.key], include: !x[g.key].include } }))}>
                  <span className={`sl-pp-check ${st?.include ? "is-on" : ""}`} aria-label="Include">
                    {st?.include && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>}
                  </span>
                  <span className={`sl-pp-ico ${g.tag === "Service" ? "is-svc" : ""}`} aria-hidden="true">
                    {g.tag === "Service" ? (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></svg>
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><path d="M3.3 7L12 12l8.7-5M12 22V12" /></svg>
                    )}
                  </span>
                  <span className="sl-pp-info">
                    <span className="sl-pp-name">{g.name}</span>
                    <span className={`sl-pp-tag ${g.tag === "Service" ? "is-svc" : ""}`}>{g.tag}</span>
                  </span>
                  <span className="sl-pp-amt">{money((g.versions.find((x) => x.id === st?.versionId) ?? g.versions[0])?.amount ?? 0)}</span>
                </button>
                {g.versions.length > 1 && (
                  <div className="sl-pp-verbar">
                    <span className="sl-pp-verlbl">Version</span>
                    <div className="sl-pp-versions">
                      {g.versions.map((v) => (
                        <button key={v.id} className={`sl-pp-ver ${st?.versionId === v.id ? "is-on" : ""}`}
                          disabled={!st?.include}
                          onClick={() => setSel((x) => ({ ...x, [g.key]: { ...x[g.key], versionId: v.id } }))}>
                          {v.label}<i>{money(v.amount)}</i>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="sl-pp-foot">
          <div className="sl-pp-total"><span>Proposal total</span><b>{money(total)}</b></div>
          <div className="sl-pp-actions">
            <button className="sl-pp-cancel" onClick={onClose}>Cancel</button>
            <button className="sl-pp-gen" onClick={() => onConfirm(sel)} disabled={!anyIncluded}>Generate {kind === "pptx" ? "PPT" : "PDF"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================ Phase editor (blueprint → PPT) ============================
function PhaseEditor({ services, onClose, onConfirm, onSkip }: {
  services: { key: string; name: string; totalDays: number; minUnit: number; phases: { name: string; percent: number; days: number; tasks: string[] }[] }[];
  onClose: () => void;
  onConfirm: (override: Record<string, { name: string; days: number; tasks: string[] }[]>) => void;
  onSkip: () => void;
}) {
  const [state, setState] = useState(() => services.map((s) => ({ ...s, phases: s.phases.map((p) => ({ ...p })) })));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const num = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "").replace(".", ",");
  const setDay = (si: number, pi: number, v: number) =>
    setState((xs) => xs.map((s, i) => i !== si ? s : { ...s, phases: s.phases.map((p, j) => j !== pi ? p : { ...p, days: v }) }));
  const resetService = (si: number) =>
    setState((xs) => xs.map((s, i) => i !== si ? s : { ...s, phases: s.phases.map((p) => ({ ...p, days: ceilTo((s.totalDays * (p.percent || 0)) / 100, s.minUnit) })) }));
  const confirm = () => {
    const o: Record<string, { name: string; days: number; tasks: string[] }[]> = {};
    state.forEach((s) => { o[s.key] = s.phases.map((p) => ({ name: p.name, days: p.days, tasks: p.tasks })); });
    onConfirm(o);
  };

  return (
    <div className="sl-pe-backdrop" onMouseDown={onClose}>
      <div className="sl-pe" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="sl-pe-head">
          <div>
            <span className="sl-pe-eyebrow">PowerPoint deck · Services breakdown</span>
            <h3 className="sl-pe-title">Review the project phases</h3>
          </div>
          <button className="sl-pe-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="sl-pe-body">
          {state.map((s, si) => {
            const sum = s.phases.reduce((a, p) => a + (Number(p.days) || 0), 0);
            const diff = +(sum - s.totalDays).toFixed(2);
            return (
              <div className="sl-pe-svc" key={s.key}>
                <div className="sl-pe-svc-head">
                  <h4>{s.name}</h4>
                  <span className="sl-pe-svc-total">{num(s.totalDays)} {s.totalDays === 1 ? "day" : "days"} total</span>
                  <button className="sl-pe-reset" onClick={() => resetService(si)} title="Reset to blueprint %">↺ Auto</button>
                </div>
                <div className="sl-pe-table">
                  <div className="sl-pe-trow sl-pe-thead">
                    <span>Phase</span><span className="sl-pe-c">%</span><span className="sl-pe-c">Calculation</span><span className="sl-pe-c">Days</span>
                  </div>
                  {s.phases.map((p, pi) => {
                    const raw = (s.totalDays * (p.percent || 0)) / 100;
                    const auto = ceilTo(raw, s.minUnit);
                    const edited = +(Number(p.days).toFixed(2)) !== +auto.toFixed(2);
                    return (
                      <div className="sl-pe-trow" key={pi}>
                        <span className="sl-pe-pname" title={p.tasks.join(" · ")}>{p.name}</span>
                        <span className="sl-pe-c sl-pe-pct">{num(p.percent)}%</span>
                        <span className="sl-pe-c sl-pe-calc">{num(s.totalDays)}×{num(p.percent)}% = <b>{raw.toFixed(2).replace(".", ",")}</b> → {num(auto)}</span>
                        <span className="sl-pe-c">
                          <input type="number" min={0} step={s.minUnit} value={p.days}
                            className={edited ? "is-edited" : ""}
                            onFocus={(e) => e.target.select()}
                            onChange={(e) => setDay(si, pi, parseFloat(e.target.value) || 0)} />
                        </span>
                      </div>
                    );
                  })}
                  <div className={`sl-pe-trow sl-pe-tfoot ${Math.abs(diff) > 0.001 ? "is-off" : ""}`}>
                    <span>Sum of phases</span><span className="sl-pe-c" /><span className="sl-pe-c">{Math.abs(diff) > 0.001 ? (diff > 0 ? `+${num(diff)} over total` : `${num(diff)} under total`) : "matches total"}</span>
                    <span className="sl-pe-c"><b>{num(sum)}</b></span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="sl-pe-foot">
          <button className="sl-pe-skip" onClick={onSkip}>Skip phases</button>
          <div className="sl-pe-actions">
            <button className="sl-pe-cancel" onClick={onClose}>Cancel</button>
            <button className="sl-pe-gen" onClick={confirm}>Generate PPT</button>
          </div>
        </div>
      </div>
    </div>
  );
}
// round up to the nearest billable unit (mirrors billableQty, kept local for the editor)
function ceilTo(raw: number, minUnit: number): number {
  const m = Number(minUnit) || 0; const q = Number(raw) || 0;
  if (m <= 0) return +q.toFixed(2);
  return +(Math.ceil(q / m) * m).toFixed(2);
}