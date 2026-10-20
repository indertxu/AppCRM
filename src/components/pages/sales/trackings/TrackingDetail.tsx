/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { createPortal } from "react-dom";
import DatePicker from "../../../framework/DatePicker";
import TimePicker from "../../../framework/TimePicker";
import Select from "../../../framework/Select";
import { loadProposalTemplateFor, renderProposal, downloadBlob, listProposalDecks, loadProposalDeckFile, deckSlidesFor, type ProposalDeckRow } from "./proposalApi";
import { parseDeck, fillDeck, loadDeckPreview, resolveTokens, deckNumbering, slideRef, isKnownToken, DECK_TOKENS, TOKEN_RE, type ProposalData, type DeckInfo, type PvDeck, type DeckContext } from "./proposalGen";
import { SlidePreview } from "../../settings/ProposalTemplateEditor";
import MentionInput, { type MentionPerson } from "../../../framework/MentionInput";
import "../../../framework/MentionInput.css";

// Convert serialized mentions "@[Name](id)" into plain "@Name".
const MEETING_KINDS: { value: MeetingKind; label: string; icon: JSX.Element }[] = [
  { value: "teams", label: "Teams", icon: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="13" height="12" rx="2"/><path d="M15 10l7-4v12l-7-4"/></svg>) },
  { value: "phone", label: "Call", icon: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>) },
  { value: "in_person", label: "In person", icon: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/></svg>) },
];

const cleanMentionsFn = (t: string) => t.replace(/@\[([^\]]+)\]\([^)]+\)/g, "@$1");
import { supabase } from "../../../api/supabase";
import HandoffClientForm from "./HandoffClientForm";
import HandoffConfirmServices, { HxPrompt, destFolder, type ConfirmService, type ConfirmProduct, type ConfirmClient, type HandoffExtras, type HandoffDoc, type HandoffPackage } from "./HandoffConfirmServices";
import TrackingFiles, { LineDocs, loadAllTrackingFiles, uploadTrackingFile, openTrackingFile, FileIcon, kindOf } from "./TrackingFiles";
import TrackingFieldsPanel, { FoldPanel } from "../extras/TrackingFieldsPanel";
import HandoverConfirm from "./HandoverConfirm";
import { planHandover, performHandover, rolesFor, resolveDealRole, saveDealRoles, orderPhases, type SalesRole, type HandoverPlan } from "../extras/salesRolesApi";
import DealRolePicker from "../extras/DealRolePicker";
import type { TrackingField } from "../extras/trackingFieldsApi";
import LineCalcModal from "../../../framework/LineCalcModal";
import { loadRoles } from "../../settings/blueprintsApi";
import { roleNameOf, type ClientRole } from "../../clients/clientsTypes";
import { useBackToClose } from "../../../framework/useBackToClose";
import { loadPipeline, listPipelines, type Phase, type Pipeline } from "../../settings/pipelineApi";
import { myProfile, isSalesLead } from "../../companies/companiesApi";
import { loadServices, calcBreakdown, discountOf, BASE_KEY, type Service, type Calculator, type CalcDiscount } from "../../settings/catalogApi";
import type { Company, Contact } from "../../companies/companiesApi";
import type { Product } from "../../settings/catalogApi";
import type { Employee } from "../sales/SalesPage";
import { useInactiveIds } from "../../../framework/peopleStatus";
import { TaskPanel, TaskWorkspace, TemplatePicker, FlagIcon, DueChip, PRIORITY_LABEL, STATUS_LABEL } from "../../homepage/shared/HomeTodo";
import {
  setTrackingPhase, setTrackingStatus, deleteTracking, setDealCloseProb, setDealCloseDate, setDealClosedOn,
  setLossReason, listLossReasons, addLossReason, updateLossReason, deleteLossReason, type LossReason,
  loadNotes, addNote, updateNote, deleteNote,
  loadTasks, addTask, toggleTask, updateTask, deleteTask, canDeleteTask,
  loadMeetings, addMeeting, updateMeeting, deleteMeeting, syncMeetingToOutlook, MEETING_OUTLOOK_EVENT, setDealName,
  syncDeletedMeetingsFromOutlook,
  loadPhaseEvents, stampPhaseEntry, clearPhaseEventsAfter, setPhaseEntryDate, fillPhaseEntries,
  loadPotentialServices, addPotentialService, updatePotentialServiceTerm, deletePotentialService,
  loadBlueprintsForServices, billableQty, type PhaseBlueprint,
  loadTrackingEmployees, setTrackingEmployees, loadTrackingOwner, setTrackingOwner,
  loadTrackingProducts, addTrackingProduct, updateTrackingProduct, removeTrackingProduct,
  setLineVersionActive, addProductVersion, addServiceVersion,
  lineTotal, lineBreakdown, unitBreakdown,
  createHandoffs, loadTrackingHandoffs, clientExistsForCompany, buildClientPrefill, buildAttachPrefill, hasClientProductsForTracking, listCatalogProducts, saveClientProducts, syncNewContactsToCompany, loadTrackingContactIds, setTrackingContacts, type Handoff,
  loadAssignees, addAssignee, removeAssignee,
  trackingPct,
  TASK_PRIORITIES, loadTaskTemplates, fromTemplate, type TaskPriority, type TaskKind, type MyTask, type TaskTemplate, type TaskStep,
  type Tracking, type TrackNote, type TrackTask, type TrackMeeting, type MeetingKind, type PhaseEvent, type PotentialService, type Assignee,
  type TrackingProduct, type TermPatch, type RevenueLineFields,
  listDealProposals, saveDealProposal, deleteDealProposal, setMainProposal, saveProposalDoc, type DealProposal, type ProposalLine, type ProposalDoc,
} from "../sales/salesApi";


/**
 * Discount for one row of a line. Defined at module level: nesting it inside
 * the modal made React remount the input on every keystroke, which is why the
 * field lost focus after a single character.
 */

/**
 * One revenue line: the numbers, a receipt you can expand, and a calculator
 * button that opens everything that decides those numbers.
 */
function RevLine({ name, tag, line, unit, minUnit, calculator, catalogBase, onRemove, onOpenCalc, money, versionIdx, versionCount, onPrev, onNext, onNewVersion, footer }: {
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
  /** Shown under the card: the proposal documents of the version on screen. */
  footer?: ReactNode;
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
    <div className={`sl-rv ${tag === "Product" ? "is-product" : "is-service"} ${open ? "is-open" : ""}`}>
      <div className="sl-rv-main" role="button" tabIndex={0} onClick={() => setOpen((o) => !o)} onKeyDown={(e) => { if (e.key === "Enter") setOpen((o) => !o); }}
        aria-expanded={open} title={open ? "Hide details" : "Show breakdown and documents"}>
        <span className="sl-rv-ico" aria-hidden="true">
          {tag === "Product" ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><path d="M3.3 7L12 12l8.7-5M12 22V12" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></svg>
          )}
        </span>
        <span className="sl-rv-txt">
          <span className="sl-rv-name" title={name}>{name}</span>
          <span className="sl-rv-sub">{summary}</span>
        </span>
        <span className="sl-rv-amt">
          <b>{money(bd.total)}</b>
          {bd.discount > 0 && <i>−{money(bd.discount)} off</i>}
          {bd.partner > 0 && <i className="is-partner" title="The partner's cut: the deal counts what is left">−{money(bd.partner)} partner</i>}
          {bd.qty !== bd.rawQty && <i className="is-round" title={`Calculated ${bd.rawQty}, billed in steps of ${minUnit}`}>{bd.rawQty} → {bd.qty}</i>}
        </span>
        <span className={`sl-rv-chev ${open ? "is-on" : ""}`} aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
        </span>
      </div>

      <div className="sl-rv-tools">
        {(versionCount ?? 1) > 1 ? (
          <span className="sl-rv-ver">
            <button onClick={onPrev} disabled={!onPrev} aria-label="Previous version">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
            <b>v{(versionIdx ?? 0) + 1}</b><i>of {versionCount}</i>
            <button onClick={onNext} disabled={!onNext} aria-label="Next version">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
            </button>
          </span>
        ) : <span className="sl-rv-ver is-one"><b>v1</b></span>}
        <span className="sl-rv-newwrap">
          <button className="sl-rv-tool" onClick={() => setVerMenu((v) => !v)} title="New version of this line">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>Version
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
        </span>
        <span className="sl-rv-spacer" />
        <button className="sl-rv-tool is-calc" onClick={onOpenCalc} title="Open the calculator">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="2" width="16" height="20" rx="2" /><path d="M8 6h8M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01M8 19h4" /></svg>
          Calculator
        </button>
        <button className="sl-rv-tool is-del" onClick={onRemove} title="Remove this line" aria-label="Remove line">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
        </button>
      </div>

      {open && (
        <div className="sl-rev-receipt sl-rv-receipt">
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
          {bd.partner > 0 && (
            <>
              <div className="sl-rc-row sl-rc-partner"><span>Partner{line.partner_mode === "percent" ? ` (${Number(line.partner_value) || 0}%)` : ""}</span><em>−{money(bd.partner)}</em></div>
              <div className="sl-rc-row sl-rc-total"><span>Deal value</span><em>{money(bd.net)}</em></div>
            </>
          )}
        </div>
      )}
      {open && footer && <div className="sl-rv-docs">{footer}</div>}
    </div>
  );
}

/* ============================ Proposals ============================ */
/** One line group of the deal, with every version it has (for building proposals). */
export interface PropGroup {
  kind: "product" | "service"; group: string; name: string;
  /** "product:<catalogue id>" / "service:<catalogue id>": whose own template applies. */
  ownerKey: string | null;
  activeId: string | null;
  versions: { id: string; label: string; total: number; partner: number; net: number }[];
}
const PROP_ICON = {
  star: "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z",
  edit: "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z",
  del: "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
  plus: "M12 5v14M5 12h14",
  sync: "M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5",
  deck: "M3 4h18v12H3zM8 20h8M12 16v4",
};
const PIco = ({ d }: { d: keyof typeof PROP_ICON }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={PROP_ICON[d]} /></svg>
);

/** Live numbers of a proposal from the deal's lines as they are now. */
export function proposalFigures(lines: ProposalLine[], groups: PropGroup[]) {
  let gross = 0, partner = 0, net = 0; const picked: { g: PropGroup; v: PropGroup["versions"][number] }[] = [];
  lines.forEach((l) => {
    if (!l.line) return;
    const g = groups.find((x) => x.kind === l.kind && x.group === l.group);
    const v = g?.versions.find((x) => x.id === l.line);
    if (!g || !v) return;
    gross += v.total; partner += v.partner; net += v.net; picked.push({ g, v });
  });
  return { gross, partner, total: net, picked };
}

function DealProposals({ trackingId, groups, decks, money, busy, reloadKey, onGenerate, onStudio, onMain }: {
  trackingId: string;
  /** The line groups a proposal can use (products / services available in proposals). */
  groups: PropGroup[];
  /** The company's proposal decks (Settings › Proposal template); empty / null = none yet. */
  decks: ProposalDeckRow[] | null;
  money: (n: number) => string;
  /** The proposal being generated, if any. */
  busy: string | null;
  reloadKey: number;
  /** The built-in generator (order form PDF; PPT when there is no deck). */
  onGenerate: (p: DealProposal, kind: "pptx" | "pdf") => void;
  /** Opens the proposal in the deck studio. */
  onStudio: (p: DealProposal) => void;
  /** After a proposal became the main one: its versions are now the active ones. */
  onMain: (p: DealProposal) => void;
}) {
  const [list, setList] = useState<DealProposal[] | null>([]);
  const [missing, setMissing] = useState(false);
  const [files, setFiles] = useState<Record<string, { name: string; storage_path: string; created_at: string }>>({});
  const [edit, setEdit] = useState<null | { id?: string; name: string; picks: Record<string, string | null>; deck_id: string | null; is_main?: boolean }>(null);
  const hasDeck = !!decks?.length;
  const defaultDeck = decks?.find((d) => d.is_default)?.id ?? decks?.[0]?.id ?? null;
  const [err, setErr] = useState<string | null>(null);
  const [delAsk, setDelAsk] = useState<string | null>(null);
  const keyOf = (g: { kind: string; group: string }) => `${g.kind}:${g.group}`;

  useEffect(() => {
    let alive = true;
    listDealProposals(trackingId).then((xs) => {
      if (!alive) return;
      setMissing(xs == null); setList(xs ?? []);
      const ids = (xs ?? []).map((p) => p.file_id).filter(Boolean) as string[];
      if (ids.length) supabase.from("tracking_files").select("id, name, storage_path, created_at").in("id", ids)
        .then(({ data }) => { if (alive) setFiles(Object.fromEntries(((data ?? []) as any[]).map((f) => [f.id, f]))); });
    });
    return () => { alive = false; };
  }, [trackingId, reloadKey]);

  const startNew = () => setEdit({
    name: `Proposal ${(list?.length ?? 0) + 1}`, deck_id: defaultDeck,
    picks: Object.fromEntries(groups.map((g) => [keyOf(g), g.activeId])),
  });
  const startEdit = (p: DealProposal) => setEdit({
    id: p.id, name: p.name, deck_id: p.deck_id ?? defaultDeck, is_main: p.is_main,
    picks: Object.fromEntries(groups.map((g) => [keyOf(g), p.lines.find((l) => keyOf(l) === keyOf(g))?.line ?? null])),
  });
  const linesOf = (picks: Record<string, string | null>): ProposalLine[] =>
    groups.map((g) => ({ kind: g.kind, group: g.group, line: picks[keyOf(g)] ?? null }));

  const save = async () => {
    if (!edit) return;
    const lines = linesOf(edit.picks);
    const f = proposalFigures(lines, groups);
    const old = list?.find((x) => x.id === edit.id);
    const { proposal, error } = await saveDealProposal({
      id: edit.id, tracking_id: trackingId, name: edit.name, lines, template_id: old?.template_id ?? null,
      deck_id: hasDeck ? edit.deck_id : undefined,
      gross: f.gross, partner: f.partner, total: f.total, file_id: old?.file_id ?? null,
      is_main: edit.id ? undefined : !(list ?? []).length,
    });
    if (error || !proposal) { setErr(error ?? "Could not save the proposal."); return; }
    setErr(null); setEdit(null);
    setList((xs) => (xs ?? []).some((x) => x.id === proposal.id) ? (xs ?? []).map((x) => x.id === proposal.id ? proposal : x) : [...(xs ?? []), proposal]);
    // The first proposal is the main one; a main one that changed moves the deal with it.
    if (proposal.is_main) await makeMain(proposal);
  };
  const makeMain = async (p: DealProposal) => {
    const e = await setMainProposal(trackingId, p);
    if (e) { setErr(e); return; }
    setErr(null);
    setList((xs) => (xs ?? []).map((x) => ({ ...x, is_main: x.id === p.id })));
    onMain(p);
  };
  const remove = async (id: string) => {
    setDelAsk(null);
    const e = await deleteDealProposal(id);
    if (e) { setErr(e); return; }
    setList((xs) => (xs ?? []).filter((x) => x.id !== id));
  };

  const main = (list ?? []).find((p) => p.is_main);
  const mainFig = main ? proposalFigures(main.lines, groups) : null;

  return (
    <FoldPanel className="sl-props-panel" title="Proposals" count={list?.length ?? 0}
      summary={main ? `Main: ${main.name} · ${money(mainFig?.total ?? 0)}` : (list?.length ? `${list.length} scenario${list.length === 1 ? "" : "s"}, none main` : "Scenarios to send the client")}
      aside={!missing && groups.length > 0 && !edit ? (
        <button type="button" className="sl-rv-tool" onClick={startNew}><PIco d="plus" />New</button>
      ) : undefined}>
      <div className="sl-props">
        {missing && <p className="sl-rvg-empty">Run 12_proposals_partners.sql in Supabase to save proposals.</p>}
        {!missing && groups.length === 0 && <p className="sl-rvg-empty">Add products or services below, then build proposals from their versions.</p>}
        {!missing && groups.length > 0 && (list ?? []).length === 0 && !edit && (
          <button type="button" className="sl-props-empty" onClick={startNew}>
            <PIco d="plus" /><span><b>Build the first proposal</b><i>Pick a version of each line; its total becomes the deal value.</i></span>
          </button>
        )}

        {(list ?? []).map((p) => {
          if (edit?.id === p.id) return null;
          const f = proposalFigures(p.lines, groups);
          // Main: every group it covers must show its version, and the ones it leaves out must be off.
          const inSync = !p.is_main || p.lines.every((l) => {
            const g = groups.find((x) => x.kind === l.kind && x.group === l.group);
            if (!g) return true;
            const want = l.line && g.versions.some((v) => v.id === l.line) ? l.line : null;
            return g.activeId === want;
          });
          const file = p.file_id ? files[p.file_id] : undefined;
          const left = groups.length - f.picked.length;
          return (
            <div key={p.id} className={`sl-prop ${p.is_main ? "is-main" : ""}`}>
              <div className="sl-prop-top">
                <span className="sl-prop-name">
                  {p.is_main && <span className="sl-prop-badge"><PIco d="star" />Main</span>}
                  <b title={p.name}>{p.name}</b>
                </span>
                <span className="sl-prop-amt">
                  <b>{money(f.total)}</b>
                  {f.partner > 0 && <i>{money(f.gross)} − {money(f.partner)} partner</i>}
                </span>
              </div>
              <div className="sl-prop-lines">
                {f.picked.map(({ g, v }) => (
                  <span key={keyOf(g)} className={`sl-prop-chip is-${g.kind}`} title={`${g.name} ${v.label}: ${money(v.total)}`}>
                    {g.name}{g.versions.length > 1 && <em>{v.label}</em>}
                  </span>
                ))}
                {left > 0 && <span className="sl-prop-chip is-out">{left} left out</span>}
              </div>
              {!inSync && (
                <p className="sl-prop-warn">
                  The deal shows other versions than this proposal.
                  <button type="button" onClick={() => makeMain(p)}><PIco d="sync" />Apply again</button>
                </p>
              )}
              <div className="sl-prop-tools">
                {!p.is_main && <button type="button" className="sl-rv-tool" onClick={() => makeMain(p)} title="Its total becomes the deal value and it is what goes to the handoff"><PIco d="star" />Make main</button>}
                <button type="button" className="sl-rv-tool" onClick={() => startEdit(p)}><PIco d="edit" />Edit</button>
                <span className="sl-rv-spacer" />
                {hasDeck ? (
                  <button type="button" className="sl-prop-deck" disabled={!!busy || !f.picked.length} onClick={() => onStudio(p)}
                    title="Fill and edit the company deck for this proposal, then download it">
                    {busy === `${p.id}:studio` ? <span className="sl-prop-spin" /> : <PIco d="deck" />}Deck
                  </button>
                ) : (
                  <button type="button" className="sl-rv-tool is-calc" disabled={!!busy || !f.picked.length} onClick={() => onGenerate(p, "pptx")}>{busy === `${p.id}:pptx` ? <span className="sl-prop-spin" /> : <PIco d="file" />}PPT</button>
                )}
                <button type="button" className="sl-rv-tool is-calc" disabled={!!busy || !f.picked.length} onClick={() => onGenerate(p, "pdf")} title="Order form (PDF)">{busy === `${p.id}:pdf` ? <span className="sl-prop-spin" /> : <PIco d="file" />}PDF</button>
                {delAsk === p.id ? (
                  <span className="sl-prop-del">
                    <button type="button" className="sl-rv-tool is-del" onClick={() => remove(p.id)}>Delete</button>
                    <button type="button" className="sl-rv-tool" onClick={() => setDelAsk(null)}>Keep</button>
                  </span>
                ) : (
                  <button type="button" className="sl-rv-tool is-del" onClick={() => setDelAsk(p.id)} aria-label="Delete proposal"><PIco d="del" /></button>
                )}
              </div>
              {file && (
                <button type="button" className="sl-prop-file" onClick={() => openTrackingFile(file.storage_path)} title={`Open ${file.name}`}>
                  <FileIcon kind={kindOf(file.name, null)} />
                  <span className="sl-prop-file-txt">
                    <b>{file.name}</b>
                    <i>Generated {new Date(file.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</i>
                  </span>
                  <span className="sl-prop-file-open" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
                  </span>
                </button>
              )}
            </div>
          );
        })}

        {edit && (() => {
          const lines = linesOf(edit.picks);
          const f = proposalFigures(lines, groups);
          return (
            <div className="sl-prop is-edit">
              <div className="sl-pz-head">
                <span className="sl-pz-eyebrow">{edit.id ? "Edit proposal" : "New proposal"}</span>
                <button type="button" className="sl-pz-x" onClick={() => setEdit(null)} aria-label="Cancel">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              </div>
              <input className="sl-pz-name" value={edit.name} autoFocus placeholder="Name it, e.g. Full platform · 3 years"
                onChange={(e) => setEdit({ ...edit, name: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEdit(null); }} />
              <div className="sl-pz-groups">
                {groups.map((g) => {
                  const cur = edit.picks[keyOf(g)] ?? null;
                  const pick = (id: string | null) => setEdit({ ...edit, picks: { ...edit.picks, [keyOf(g)]: id } });
                  return (
                    <div key={keyOf(g)} className={`sl-pz-g is-${g.kind} ${cur ? "" : "is-off"}`}>
                      <div className="sl-pz-g-head">
                        <i className="sl-pz-dot" />
                        <b title={g.name}>{g.name}</b>
                        <span className="sl-pz-kind">{g.kind === "product" ? "Product" : "Service"}</span>
                      </div>
                      <div className="sl-pz-opts">
                        {g.versions.map((v) => (
                          <button type="button" key={v.id} className={`sl-pz-opt ${cur === v.id ? "is-on" : ""}`} onClick={() => pick(v.id)}
                            title={v.partner > 0 ? `${money(v.total)} − ${money(v.partner)} partner` : money(v.total)}>
                            <span className="sl-pz-check" />
                            <span className="sl-pz-opt-txt">
                              <span className="sl-pz-opt-lbl">{v.label}</span>
                              <span className="sl-pz-opt-amt">{money(v.net)}</span>
                            </span>
                          </button>
                        ))}
                        <button type="button" className={`sl-pz-opt is-out ${!cur ? "is-on" : ""}`} onClick={() => pick(null)}>
                          <span className="sl-pz-check" />
                          <span className="sl-pz-opt-txt"><span className="sl-pz-opt-lbl">Leave out</span><span className="sl-pz-opt-amt">Not included</span></span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              {(decks?.length ?? 0) > 1 && (
                <label className="sl-pz-tpl">
                  <span>Deck</span>
                  <select value={edit.deck_id ?? ""} onChange={(e) => setEdit({ ...edit, deck_id: e.target.value || null })}>
                    {decks!.map((d) => <option key={d.id} value={d.id}>{d.name}{d.is_default ? " (default)" : ""}</option>)}
                  </select>
                </label>
              )}
              <div className="sl-pz-foot">
                <div className="sl-pz-sum">
                  <div><span>Client pays</span><b>{money(f.gross)}</b></div>
                  {f.partner > 0 && <div className="is-partner"><span>Partners</span><b>−{money(f.partner)}</b></div>}
                  <div className="is-total"><span>Deal value</span><b>{money(f.total)}</b></div>
                </div>
                <div className="sl-pz-actions">
                  <button type="button" className="sl-pz-cancel" onClick={() => setEdit(null)}>Cancel</button>
                  <button type="button" className="sl-prop-save" disabled={!edit.name.trim() || !f.picked.length} onClick={save}>{edit.id ? "Save changes" : "Create proposal"}</button>
                </div>
              </div>
            </div>
          );
        })()}
        {err && <p className="sl-rev-err">{err}</p>}
      </div>
    </FoldPanel>
  );
}

/* ============================ Proposal studio ============================ */
/** One slide of the proposal: a slide of the deck, for one product / service when its rule says so. */
interface StudioEntry { n: number; ref: string; scope: { product?: number; service?: number }; title: string; who: string; kind: "always" | "product" | "service" }

/** Where an override of a field applies: product / service fields are per line, the rest everywhere. */
const fieldKey = (token: string, scope: { product?: number; service?: number }) =>
  token.startsWith("product") ? `${token}@p${scope.product ?? 0}` : token.startsWith("service") ? `${token}@s${scope.service ?? 0}` : token;
const tokenOfField = (key: string) => key.replace(/@[ps]\d+$/, "");
const fileSafe = (s: string) => s.replace(/[^\w\-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 60);

const STUDIO_ICON = {
  close: "M6 6l12 12M18 6L6 18",
  down: "M12 4v11M7 10l5 5 5-5M5 20h14",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  eyeOff: "M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.9 8.3 2 12 2 12s3.6 7 10 7a9.8 9.8 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2",
  left: "M15 18l-6-6 6-6",
  right: "M9 18l6-6-6-6",
  reset: "M3 12a9 9 0 1 0 2.6-6.4M3 4v5h5",
  text: "M4 7V5h16v2M9 19h6M12 5v14",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  alert: "M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  check: "M20 6L9 17l-5-5",
  cursor: "M4 4l7 17 2.5-7.5L21 11z",
};
const SIco = ({ d, className }: { d: keyof typeof STUDIO_ICON; className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={STUDIO_ICON[d]} /></svg>
);

/** A slide's name for the list: its biggest text (the title), else what the deck file says. */
function slideTitleOf(pv: PvDeck | null, n: number, fallback: string): string {
  const sl = pv?.slides.find((x) => x.n === n);
  let best = "", size = 0, top = Infinity;
  sl?.shapes.forEach((sh) => {
    if (sh.layer !== "slide" || !sh.text) return;
    sh.text.paras.forEach((p) => {
      const txt = p.runs.map((r) => r.text).join("").replace(TOKEN_RE, "").replace(/\s+/g, " ").trim();
      if (txt.replace(/[^A-Za-zÀ-ÿ]/g, "").length < 4) return;
      const sz = Math.max(0, ...p.runs.map((r) => r.size)) * (sh.text!.scale ?? 1);
      if (sz > size + 0.5 || (Math.abs(sz - size) <= 0.5 && sh.y < top)) { best = txt; size = sz; top = sh.y; }
    });
  });
  const t = (best || fallback).replace(/^[\s\-–—·|:]+/, "");
  // titles in capitals read better as "Propuesta económica"
  return t === t.toUpperCase() ? t.charAt(0) + t.slice(1).toLowerCase() : t;
}
const FIELD_LABELS: Record<string, string> = { agenda: "Agenda (one line per product / service)", "agenda.upper": "Agenda, in capitals" };
const niceLabel = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A slide thumbnail drawn only once it scrolls into view (a deck can be heavy). */
function StudioThumb({ deck, entry, values, edits, width }: { deck: PvDeck; entry: StudioEntry; values: Record<string, string>; edits: Record<string, string>; width: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver((xs) => { if (xs.some((x) => x.isIntersecting)) { setSeen(true); io.disconnect(); } }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  const h = (width * deck.cy) / deck.cx;
  return (
    <div ref={ref} className="pst-thumb-img" style={{ width, height: h }}>
      {seen && <SlidePreview deck={deck} n={entry.n} refId={entry.ref} values={values} edits={edits} width={width} />}
    </div>
  );
}

function ProposalStudio({ proposal, decks, data, productIds, serviceIds, seller, onClose, onSaveDoc, onGenerated }: {
  proposal: DealProposal;
  decks: ProposalDeckRow[];
  data: ProposalData;
  /** Catalogue ids of data.products / data.services, same order (which slides go in). */
  productIds: string[]; serviceIds: string[];
  seller: { name?: string; email?: string; phone?: string };
  onClose: () => void;
  onSaveDoc: (deckId: string | null, doc: ProposalDoc) => Promise<string | null>;
  /** The generated file: keep it on the deal. Returns an error, if any. */
  onGenerated: (blob: Blob, fileName: string) => Promise<string | null>;
}) {
  const [deckId, setDeckId] = useState<string | null>(() =>
    proposal.deck_id && decks.some((d) => d.id === proposal.deck_id) ? proposal.deck_id : (decks.find((d) => d.is_default)?.id ?? decks[0]?.id ?? null));
  const deck = decks.find((d) => d.id === deckId) ?? null;
  const [stage, setStage] = useState<"download" | "read" | "ready" | "error">("download");
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [buf, setBuf] = useState<ArrayBuffer | null>(null);
  const [info, setInfo] = useState<DeckInfo | null>(null);
  const [pv, setPv] = useState<PvDeck | null>(null);
  const [doc, setDoc] = useState<ProposalDoc>(() => ({
    values: { ...(proposal.doc?.values ?? {}) }, edits: { ...(proposal.doc?.edits ?? {}) }, slides: { ...(proposal.doc?.slides ?? {}) },
  }));
  const [sel, setSel] = useState<string | null>(null);         // selected slide ref
  const [selKey, setSelKey] = useState<string | null>(null);   // selected text
  const [tab, setTab] = useState<"text" | "fields">("text");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [gen, setGen] = useState<"idle" | "building" | "saving" | "done">("idle");
  const [genMsg, setGenMsg] = useState<string | null>(null);
  const [askMissing, setAskMissing] = useState(false);

  // ---- the deck file: downloaded and read once per deck ----
  useEffect(() => {
    if (!deck) return;
    let alive = true;
    setStage("download"); setLoadErr(null); setInfo(null); setPv(null); setBuf(null);
    (async () => {
      try {
        const b = await loadProposalDeckFile(deck);
        if (!alive) return;
        setStage("read");
        const [i, p] = await Promise.all([parseDeck(b), loadDeckPreview(b)]);
        if (!alive) return;
        setBuf(b); setInfo(i); setPv(p); setStage("ready");
      } catch (e: any) {
        if (alive) { setStage("error"); setLoadErr(e?.message ?? "Could not open the deck."); }
      }
    })();
    return () => { alive = false; };
  }, [deck?.id, deck?.storage_path]);

  // ---- which slides go in ----
  const plan: StudioEntry[] = useMemo(() => {
    if (!deck || !info) return [];
    // a slide without a rule (added to the file later) goes in always
    const rules = info.slides.map((s) => deck.slides.find((r) => r.n === s.n) ?? { n: s.n, when: "always" as const, ids: [] });
    const occ = new Map<number, number>();
    return deckSlidesFor(rules, productIds, serviceIds).map((e) => {
      const i = occ.get(e.n) ?? 0; occ.set(e.n, i + 1);
      const sl = info.slides.find((s) => s.n === e.n);
      const who = e.scope.product != null ? data.products[e.scope.product]?.name ?? "" : e.scope.service != null ? data.services[e.scope.service]?.name ?? "" : "";
      return { n: e.n, ref: slideRef(e.n, i), scope: e.scope, title: slideTitleOf(pv, e.n, sl?.title || `Slide ${e.n}`), who, kind: e.scope.product != null ? "product" : e.scope.service != null ? "service" : "always" };
    });
  }, [deck, info, pv, productIds, serviceIds, data]);
  const included = plan.filter((e) => doc.slides?.[e.ref] !== false);
  const nums = useMemo(() => (info ? deckNumbering(info, included.map((e) => e.n)) : []), [info, included.map((e) => e.ref).join()]);
  const numOf = (ref: string) => { const i = included.findIndex((e) => e.ref === ref); return i >= 0 ? nums[i] ?? "" : ""; };
  useEffect(() => { if (plan.length && (!sel || !plan.some((e) => e.ref === sel))) setSel(plan[0].ref); }, [plan, sel]);

  // ---- values: from the deal, then the seller's overrides ----
  const ctx: DeckContext = useMemo(() => ({
    data, proposalName: proposal.name, validityDays: 30, lang: "es",
    sellerName: seller.name, sellerEmail: seller.email, sellerPhone: seller.phone,
  }), [data, proposal.name, seller.name, seller.email, seller.phone]);
  const autoCache = useMemo(() => new Map<string, Record<string, string>>(), [ctx]);
  const autoFor = (scope: StudioEntry["scope"]) => {
    const k = `${scope.product ?? "-"}:${scope.service ?? "-"}`;
    let v = autoCache.get(k);
    if (!v) { v = resolveTokens(ctx, scope); autoCache.set(k, v); }
    return v;
  };
  const valuesFor = (e: StudioEntry): Record<string, string> => {
    const v: Record<string, string> = { ...autoFor(e.scope), num: numOf(e.ref) };
    Object.entries(doc.values ?? {}).forEach(([k, val]) => {
      const tok = tokenOfField(k);
      if (fieldKey(tok, e.scope) === k) v[tok] = val;
    });
    return v;
  };

  // ---- the fields the kept slides use ----
  const fields = useMemo(() => {
    if (!info) return [] as { key: string; token: string; group: string; label: string; auto: string; free: boolean; multi: boolean; slides: number }[];
    const out = new Map<string, { key: string; token: string; group: string; label: string; auto: string; free: boolean; multi: boolean; slides: number }>();
    included.forEach((e) => {
      const sl = info.slides.find((s) => s.n === e.n);
      (sl?.tokens ?? []).forEach((t) => {
        if (t === "num" || t.includes("#")) return;
        const key = fieldKey(t, e.scope);
        const prev = out.get(key);
        if (prev) { prev.slides++; return; }
        const def = DECK_TOKENS.find((d) => d.key === t || (d.key.includes("N") && new RegExp(`^${d.key.replace(/\./g, "\\.").replace(/N/g, "\\d+")}$`).test(t)));
        const free = !isKnownToken(t);
        const pi = e.scope.product ?? 0, si = e.scope.service ?? 0;
        const group = free ? "To fill in" : t.startsWith("product") ? `Product · ${data.products[pi]?.name ?? "—"}` : t.startsWith("service") ? `Service · ${data.services[si]?.name ?? "—"}` : "General";
        out.set(key, {
          key, token: t, group, free, slides: 1, multi: !!def?.multi,
          label: FIELD_LABELS[t] ?? (def?.label ? (def.key === t ? def.label : `${def.label} ${t.match(/\d+/)?.[0] ?? ""}`.trim()) : niceLabel(t.replace(/[._]/g, " "))),
          auto: free ? "" : autoFor(e.scope)[t] ?? "",
        });
      });
    });
    const order = (g: string) => (g === "To fill in" ? 0 : g === "General" ? 1 : g.startsWith("Product") ? 2 : 3);
    return Array.from(out.values()).sort((a, b) => order(a.group) - order(b.group) || a.group.localeCompare(b.group));
  }, [info, included.map((e) => e.ref).join(), ctx]);
  const missing = fields.filter((f) => f.free && !(doc.values?.[f.key] ?? "").trim());

  // ---- autosave ----
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setSaveState("saving");
    const t = setTimeout(async () => {
      const e = await onSaveDoc(deckId, doc);
      setSaveErr(e); setSaveState(e ? "error" : "saved");
    }, 700);
    return () => clearTimeout(t);
  }, [doc, deckId]);

  const setValue = (key: string, v: string | null) => setDoc((d) => {
    const values = { ...(d.values ?? {}) };
    if (v == null) delete values[key]; else values[key] = v;
    return { ...d, values };
  });
  const setEdit = (key: string, v: string | null) => setDoc((d) => {
    const edits = { ...(d.edits ?? {}) };
    if (v == null) delete edits[key]; else edits[key] = v;
    return { ...d, edits };
  });
  const toggleSlide = (ref: string) => setDoc((d) => {
    const slides = { ...(d.slides ?? {}) };
    if (slides[ref] === false) delete slides[ref]; else slides[ref] = false;
    return { ...d, slides };
  });
  const switchDeck = (id: string) => {
    // texts and slides belong to the deck they were changed in; the field values carry over
    setDoc((d) => ({ values: d.values, edits: {}, slides: {} }));
    setSelKey(null); setSel(null); setDeckId(id);
  };

  // ---- the selected slide and text ----
  const cur = plan.find((e) => e.ref === sel) ?? null;
  const curVals = cur ? valuesFor(cur) : {};
  const curIdx = cur ? plan.indexOf(cur) : -1;
  const go = (d: number) => { const e = plan[curIdx + d]; if (e) { setSel(e.ref); setSelKey(null); } };
  const textInfo = useMemo(() => {
    if (!selKey || !cur || !info) return null;
    const rest = selKey.slice(cur.ref.length + 1);
    const rep = /r(\d+)\.(\d+)c/.exec(rest);
    const baseKey = `${cur.n}:${rest.replace(/r(\d+)\.(\d+)c/, "r$1c")}`;
    const t = info.slides.find((s) => s.n === cur.n)?.texts.find((x) => x.key === baseKey);
    if (!t) return null;
    const tpl = rep ? t.text.replace(/#/g, rep[2]) : t.text;
    const auto = tpl.replace(TOKEN_RE, (_m, k: string) => curVals[k.trim()] ?? (isKnownToken(k.trim()) ? "" : `{{${k.trim()}}}`));
    return { template: tpl, auto, tokens: Array.from(tpl.matchAll(TOKEN_RE), (m) => m[1].trim()) };
  }, [selKey, cur?.ref, info, JSON.stringify(curVals)]);

  // ---- the center stage size ----
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageW, setStageW] = useState(900);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      const ratio = pv ? pv.cy / pv.cx : 9 / 16;
      setStageW(Math.max(320, Math.floor(Math.min(r.width - 64, (r.height - 96) / ratio))));
    };
    fit();
    const ro = new ResizeObserver(fit); ro.observe(el);
    return () => ro.disconnect();
  }, [stage, pv]);

  // ---- keys: Esc closes, ↑ ↓ move between slides (not while typing) ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /input|textarea|select/i.test((e.target as HTMLElement)?.tagName ?? "");
      if (e.key === "Escape") { if (typing) (e.target as HTMLElement).blur(); else if (selKey) setSelKey(null); else onClose(); }
      if (typing) return;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); go(1); }
      if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
      if (e.key === "Delete" && cur) { e.preventDefault(); toggleSlide(cur.ref); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---- generate ----
  const generate = async (force = false) => {
    if (!buf || !info) return;
    if (missing.length && !force) { setTab("fields"); setAskMissing(true); return; }
    setAskMissing(false); setGen("building"); setGenMsg(null);
    try {
      // edits are keyed by the slide's place in the plan; in the file, copies count among the kept slides only
      const occ = new Map<number, number>();
      const genRef = new Map<string, string>();
      included.forEach((e) => { const g = occ.get(e.n) ?? 0; occ.set(e.n, g + 1); genRef.set(e.ref, slideRef(e.n, g)); });
      const edits: Record<string, string> = {};
      Object.entries(doc.edits ?? {}).forEach(([k, v]) => {
        const i = k.indexOf(":");
        const to = genRef.get(k.slice(0, i));
        if (to) edits[`${to}${k.slice(i)}`] = v;
      });
      const byN = new Map<number, StudioEntry[]>();
      included.forEach((e) => byN.set(e.n, [...(byN.get(e.n) ?? []), e]));
      const blob = await fillDeck(buf, {
        include: included.map((e) => e.n),
        values: (n, i) => { const e = byN.get(n)?.[i]; return e ? valuesFor(e) : {}; },
        edits,
      });
      const fileName = `${fileSafe(data.client.name || "Client")}-${fileSafe(proposal.name || "Proposal")}.pptx`;
      downloadBlob(blob, fileName);
      setGen("saving");
      const e = await onGenerated(blob, fileName);
      setGen("done"); setGenMsg(e ? `Downloaded, but not saved on the deal: ${e}` : "Downloaded and saved in the deal documents");
      setTimeout(() => setGen((g) => (g === "done" ? "idle" : g)), 4000);
    } catch (e: any) {
      setGen("idle"); setGenMsg(e?.message ?? "Could not build the deck.");
    }
  };

  const thumbW = typeof window !== "undefined" && window.innerWidth <= 1180 ? 160 : 200;
  const kindLabel = (e: StudioEntry) => (e.kind === "product" ? "Product" : e.kind === "service" ? "Service" : "");
  const groups = Array.from(new Set(fields.map((f) => f.group)));

  return createPortal(
    <div className="pst-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pst" role="dialog" aria-modal="true" aria-label="Proposal deck">
        {/* ---- header ---- */}
        <header className="pst-head">
          <div className="pst-head-l">
            <span className="pst-logo"><SIco d="list" /></span>
            <div className="pst-titles">
              <span className="pst-eyebrow">Proposal deck</span>
              <h2 className="pst-title" title={proposal.name}>{proposal.name}</h2>
            </div>
            <span className="pst-chip">{data.client.name}</span>
            {stage === "ready" && <span className="pst-chip is-soft">{included.length} of {plan.length} slides</span>}
          </div>
          <div className="pst-head-r">
            {decks.length > 1 && (
              <label className="pst-decksel">
                <span>Deck</span>
                <select value={deckId ?? ""} onChange={(e) => switchDeck(e.target.value)}>
                  {decks.map((d) => <option key={d.id} value={d.id}>{d.name}{d.is_default ? " · default" : ""}</option>)}
                </select>
              </label>
            )}
            <span className={`pst-save is-${saveState}`} title={saveErr ?? undefined}>
              {saveState === "saving" ? <><span className="pst-spin" />Saving…</> : saveState === "saved" ? <><SIco d="check" />Saved</> : saveState === "error" ? <><SIco d="alert" />Not saved</> : <>Changes save automatically</>}
            </span>
            <button type="button" className="pst-primary" disabled={stage !== "ready" || gen === "building" || gen === "saving" || !included.length} onClick={() => generate()}>
              {gen === "building" ? <><span className="pst-spin is-light" />Building…</> : gen === "saving" ? <><span className="pst-spin is-light" />Saving…</> : gen === "done" ? <><SIco d="check" />Done</> : <><SIco d="down" />Download PPTX</>}
            </button>
            <button type="button" className="pst-x" onClick={onClose} aria-label="Close"><SIco d="close" /></button>
          </div>
        </header>
        {genMsg && <div className={`pst-toast ${/not|could/i.test(genMsg) ? "is-warn" : ""}`}>{genMsg}<button type="button" onClick={() => setGenMsg(null)} aria-label="Dismiss"><SIco d="close" /></button></div>}

        {stage !== "ready" ? (
          <div className="pst-loading">
            {stage === "error" ? (
              <div className="pst-load-card is-err">
                <SIco d="alert" />
                <b>Could not open the deck</b>
                <span>{loadErr}</span>
                <button type="button" className="pst-ghost" onClick={onClose}>Close</button>
              </div>
            ) : (
              <div className="pst-load-card">
                <span className="pst-load-ring" />
                <b>{stage === "download" ? "Downloading the deck…" : "Reading the slides…"}</b>
                <span>{deck?.file_name ?? deck?.name}{deck?.size_bytes ? ` · ${(deck.size_bytes / 1048576).toFixed(1)} MB` : ""}</span>
                <div className="pst-load-steps">
                  <i className="is-on" /><i className={stage === "read" ? "is-on" : ""} /><i />
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="pst-body">
            {/* ---- slides ---- */}
            <aside className="pst-slides">
              <div className="pst-side-head">
                <span>Slides</span>
                <em>{included.length}/{plan.length}</em>
              </div>
              <div className="pst-slide-list">
                {plan.map((e, i) => {
                  const on = doc.slides?.[e.ref] !== false;
                  const num = numOf(e.ref);
                  const prevKind = i > 0 ? `${plan[i - 1].kind}:${plan[i - 1].who}` : "";
                  const showSection = e.kind !== "always" && `${e.kind}:${e.who}` !== prevKind;
                  return (
                    <div key={e.ref}>
                      {showSection && <div className={`pst-sec is-${e.kind}`} title={e.who}><i /><span>{kindLabel(e)} · {e.who}</span></div>}
                      <div className={`pst-thumb ${sel === e.ref ? "is-sel" : ""} ${on ? "" : "is-off"}`}
                        onClick={() => { setSel(e.ref); setSelKey(null); }}>
                        <div className="pst-thumb-top">
                          <span className="pst-thumb-n">{i + 1}</span>
                          <span className="pst-thumb-t" title={e.title}>{num ? <b>{num}</b> : null}{e.title}</span>
                          <button type="button" className={`pst-eye ${on ? "" : "is-off"}`} title={on ? "Leave this slide out" : "Put this slide back"}
                            onClick={(ev) => { ev.stopPropagation(); toggleSlide(e.ref); }}>
                            <SIco d={on ? "eye" : "eyeOff"} />
                          </button>
                        </div>
                        <div className="pst-thumb-frame">
                          <StudioThumb deck={pv!} entry={e} values={valuesFor(e)} edits={doc.edits ?? {}} width={thumbW} />
                          {!on && <span className="pst-thumb-out">Left out</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
                {!plan.length && <p className="pst-empty">No slide of this deck goes with these products and services. Check the slide rules in Settings › Proposal template.</p>}
              </div>
            </aside>

            {/* ---- stage ---- */}
            <main className="pst-stage" ref={stageRef} onClick={() => setSelKey(null)}>
              {cur && pv && (
                <>
                  <div className={`pst-canvas ${doc.slides?.[cur.ref] === false ? "is-off" : ""}`} style={{ width: stageW }} onClick={(e) => e.stopPropagation()}>
                    <SlidePreview deck={pv} n={cur.n} refId={cur.ref} values={curVals} edits={doc.edits ?? {}} width={stageW}
                      onPickText={(k) => { setSelKey(k); setTab("text"); }} highlightKey={selKey} />
                    {doc.slides?.[cur.ref] === false && (
                      <div className="pst-canvas-off"><span>Left out of this proposal</span>
                        <button type="button" onClick={() => toggleSlide(cur.ref)}><SIco d="eye" />Put it back</button></div>
                    )}
                  </div>
                  <div className="pst-stage-bar" onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="pst-nav" disabled={curIdx <= 0} onClick={() => go(-1)} aria-label="Previous slide"><SIco d="left" /></button>
                    <span className="pst-stage-cap">
                      <b>Slide {curIdx + 1}</b> of {plan.length}
                      {cur.who && <em className={`is-${cur.kind}`}>{cur.who}</em>}
                    </span>
                    <button type="button" className="pst-nav" disabled={curIdx >= plan.length - 1} onClick={() => go(1)} aria-label="Next slide"><SIco d="right" /></button>
                    {doc.slides?.[cur.ref] === false ? (
                      <button type="button" className="pst-rm is-back" onClick={() => toggleSlide(cur.ref)} title="Put this slide back in the proposal"><SIco d="eye" />Put back</button>
                    ) : (
                      <button type="button" className="pst-rm" onClick={() => toggleSlide(cur.ref)} title="Remove this slide from the proposal (Delete key)"><SIco d="eyeOff" />Remove slide</button>
                    )}
                    <span className="pst-hint"><SIco d="cursor" />Click any text to edit it</span>
                  </div>
                </>
              )}
            </main>

            {/* ---- editor ---- */}
            <aside className="pst-edit">
              <div className="pst-tabs">
                <button type="button" className={tab === "text" ? "is-on" : ""} onClick={() => setTab("text")}><SIco d="text" />Text</button>
                <button type="button" className={tab === "fields" ? "is-on" : ""} onClick={() => setTab("fields")}>
                  <SIco d="list" />Fields{missing.length > 0 ? <span className="pst-badge is-warn">{missing.length}</span> : <span className="pst-badge">{fields.length}</span>}
                </button>
              </div>
              <div className="pst-edit-body">
                {tab === "text" ? (
                  !selKey || !textInfo ? (
                    <div className="pst-blank">
                      <span className="pst-blank-ico"><SIco d="cursor" /></span>
                      <b>Pick a text on the slide</b>
                      <p>Every text is editable. Values from the deal (client, prices, phases…) are filled in for you; change them here or in <button type="button" onClick={() => setTab("fields")}>Fields</button> to change them everywhere.</p>
                      {missing.length > 0 && (
                        <button type="button" className="pst-miss" onClick={() => setTab("fields")}>
                          <SIco d="alert" />{missing.length} field{missing.length === 1 ? "" : "s"} still to fill in
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="pst-text">
                      <div className="pst-lbl-row">
                        <span className="pst-lbl">Text on this slide</span>
                        {doc.edits?.[selKey] !== undefined && <span className="pst-tag">Edited</span>}
                      </div>
                      <textarea className="pst-area" autoFocus rows={6}
                        value={doc.edits?.[selKey] ?? textInfo.auto}
                        onChange={(e) => setEdit(selKey, e.target.value)} />
                      {doc.edits?.[selKey] !== undefined && (
                        <button type="button" className="pst-reset" onClick={() => setEdit(selKey, null)}><SIco d="reset" />Back to automatic</button>
                      )}
                      {textInfo.tokens.length > 0 && (
                        <div className="pst-src">
                          <span className="pst-lbl">From the template</span>
                          <p>{textInfo.template.split(TOKEN_RE).map((part, i) => i % 2 ? <code key={i}>{part.trim()}</code> : <span key={i}>{part}</span>)}</p>
                          <span className="pst-note">
                            {doc.edits?.[selKey] !== undefined
                              ? "This text is now fixed: changes to the deal no longer update it."
                              : "Filled from the deal. Typing here fixes this text only; use Fields to change a value everywhere."}
                          </span>
                          <div className="pst-src-fields">
                            {Array.from(new Set(textInfo.tokens)).filter((t) => t !== "num" && !t.includes("#")).map((t) => (
                              <button type="button" key={t} onClick={() => { setTab("fields"); setTimeout(() => document.getElementById(`pst-f-${fieldKey(t, cur!.scope)}`)?.focus(), 60); }}>
                                {t}<SIco d="right" />
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                ) : (
                  <div className="pst-fields">
                    {askMissing && missing.length > 0 && (
                      <div className="pst-ask">
                        <SIco d="alert" />
                        <div>
                          <b>{missing.length} field{missing.length === 1 ? "" : "s"} without a value</b>
                          <span>They would come out empty in the deck.</span>
                          <button type="button" onClick={() => generate(true)}>Download anyway</button>
                        </div>
                      </div>
                    )}
                    {!fields.length && <p className="pst-empty">The kept slides use no fields.</p>}
                    {groups.map((g) => (
                      <section key={g} className={`pst-fgroup ${g === "To fill in" ? "is-free" : ""}`}>
                        <h4>{g}</h4>
                        {fields.filter((f) => f.group === g).map((f) => {
                          const v = doc.values?.[f.key];
                          const changed = v !== undefined;
                          const need = f.free && !(v ?? "").trim();
                          const common = {
                            id: `pst-f-${f.key}`, className: `pst-input ${need ? "is-need" : ""}`, value: v ?? f.auto,
                            placeholder: f.free ? "Type the value for this proposal" : "Empty",
                            onChange: (e: any) => setValue(f.key, e.target.value),
                          };
                          return (
                            <label key={f.key} className={`pst-field ${changed && !f.free ? "is-changed" : ""}`}>
                              <span className="pst-field-top">
                                <span className="pst-field-l">{f.label}</span>
                                {changed && !f.free && <button type="button" className="pst-mini" onClick={(e) => { e.preventDefault(); setValue(f.key, null); }} title={`Automatic: ${f.auto || "empty"}`}><SIco d="reset" />Auto</button>}
                                {f.slides > 1 && <em>{f.slides} slides</em>}
                              </span>
                              {f.multi || (v ?? f.auto).includes("\n") ? <textarea rows={3} {...common} /> : <input {...common} />}
                            </label>
                          );
                        })}
                      </section>
                    ))}
                  </div>
                )}
              </div>
            </aside>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Status shown to people: "paused" is called "hold" (the stored value stays "paused"). */
const statusText = (s: string | null | undefined) => (s === "paused" ? "hold" : s ?? "");

/**
 * The deal's people: its contacts first, then the rest of the company's
 * contacts (one click adds them to the deal).
 */
/** Small "links" menu: a chevron that opens every place you can jump to. */
type QuickLink = { label: string; sub?: string; icon: string; href?: string; ext?: boolean; onClick?: () => void };
const QL_ICON: Record<string, string> = {
  open: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3",
  phone: "M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z",
  mail: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6",
  globe: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z",
  linkedin: "M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6zM2 9h4v12H2zM4 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  building: "M3 21h18M5 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16M16 9h3a2 2 0 0 1 2 2v10M9 7h3M9 11h3M9 15h3",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  pin: "M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0zM12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
};
const QlIco = ({ n, s = 14 }: { n: string; s?: number }) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill={n === "linkedin" ? "currentColor" : "none"} stroke={n === "linkedin" ? "none" : "currentColor"} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={QL_ICON[n] ?? QL_ICON.open} /></svg>
);
function LinksMenu({ links, label }: { links: QuickLink[]; label: string }) {
  const [open, setOpen] = useState(false);
  if (!links.length) return null;
  return (
    <span className="sl-ql">
      <button type="button" className={`sl-ql-btn ${open ? "is-on" : ""}`} onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }} aria-label={label} title={label}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <>
          <span className="sl-ql-scrim" onMouseDown={() => setOpen(false)} />
          <span className="sl-ql-menu" role="menu">
            {links.map((l) => {
              const body = <><span className="sl-ql-ico"><QlIco n={l.icon} /></span><span className="sl-ql-t"><b>{l.label}</b>{l.sub && <small>{l.sub}</small>}</span></>;
              return l.href
                ? <a key={l.label} role="menuitem" href={l.href} {...(l.ext ? { target: "_blank", rel: "noreferrer" } : {})} onClick={() => setOpen(false)}>{body}</a>
                : <button key={l.label} role="menuitem" type="button" onClick={() => { setOpen(false); l.onClick?.(); }}>{body}</button>;
            })}
          </span>
        </>
      )}
    </span>
  );
}
const webHref = (w?: string | null) => { const s = String(w ?? "").trim(); return !s ? "" : /^https?:\/\//i.test(s) ? s : `https://${s}`; };
const telOf = (p?: string | null) => `tel:${String(p ?? "").replace(/[^\d+]/g, "")}`;
/** Everywhere a company can be reached from: Companies, web, LinkedIn, phones, email, map. */
function companyQuickLinks(company: Company, openCompany: () => void): QuickLink[] {
  const coAddr = [company.street, company.addr_number, company.postal_code, company.city, company.country].filter(Boolean).join(" ");
  const li = String((company as any).linkedin ?? "");
  return [
    { label: "Open in Companies", icon: "building", onClick: openCompany },
    ...(company.website ? [{ label: "Website", sub: company.website.replace(/^https?:\/\//i, ""), icon: "globe", href: webHref(company.website), ext: true }] : []),
    ...(li ? [{ label: "LinkedIn", sub: li.replace(/^https?:\/\/(www\.)?linkedin\.com\//i, ""), icon: "linkedin", href: li, ext: true }] : []),
    ...(company.phone ? [{ label: "Call", sub: company.phone, icon: "phone", href: telOf(company.phone) }] : []),
    ...(company.landline ? [{ label: "Call landline", sub: company.landline, icon: "phone", href: telOf(company.landline) }] : []),
    ...(company.email ? [{ label: "Email", sub: company.email, icon: "mail", href: `mailto:${company.email}` }] : []),
    ...(coAddr ? [{ label: "Map", sub: coAddr, icon: "pin", href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(coAddr)}`, ext: true }] : []),
  ];
}

function DealPeople({ company, contacts, companyContactIds, dealIds, onChange }: {
  company: Company | undefined; contacts: Contact[]; companyContactIds: string[]; dealIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const navigate = useNavigate();
  const [showAll, setShowAll] = useState(false);
  const byId = new Map(contacts.map((c) => [c.id!, c]));
  const onDeal = dealIds.map((id) => byId.get(id)).filter((c): c is Contact => !!c);
  const others = companyContactIds.filter((id) => !dealIds.includes(id)).map((id) => byId.get(id)).filter((c): c is Contact => !!c)
    .sort((a, b) => `${a.first_name} ${a.last_name ?? ""}`.localeCompare(`${b.first_name} ${b.last_name ?? ""}`));
  const othersShown = showAll ? others : others.slice(0, 3);
  const name = (c: Contact) => [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || "Contact";
  const ini = (c: Contact) => name(c).split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const openContact = (c: Contact) => c.id && navigate("/contacts", { state: { focusContactId: c.id } });
  const openCompany = () => company?.id && navigate("/companies", { state: { focusCompanyId: company.id } });
  const contactLinks = (c: Contact): QuickLink[] => [
    { label: "Open in Contacts", icon: "user", onClick: () => openContact(c) },
    ...(c.phone ? [{ label: "Call", sub: c.phone, icon: "phone", href: telOf(c.phone) }] : []),
    ...(c.landline ? [{ label: "Call landline", sub: c.landline, icon: "phone", href: telOf(c.landline) }] : []),
    ...(c.email ? [{ label: "Email", sub: c.email, icon: "mail", href: `mailto:${c.email}` }] : []),
    ...(c.linkedin ? [{ label: "LinkedIn", sub: c.linkedin.replace(/^https?:\/\/(www\.)?linkedin\.com\//i, ""), icon: "linkedin", href: c.linkedin, ext: true }] : []),
    ...(company ? [{ label: `Open ${company.name}`, sub: "in Companies", icon: "building", onClick: openCompany }] : []),
  ];
  const companyLinks: QuickLink[] = company ? companyQuickLinks(company, openCompany) : [];
  const row = (c: Contact, inDeal: boolean, i: number) => (
    <div key={c.id} className={`sl-ppl ${inDeal ? "is-deal" : ""}`} style={{ ["--i" as string]: Math.min(i, 10) } as CSSProperties}>
      <button type="button" className="sl-ppl-av" onClick={() => openContact(c)} title="Open in Contacts">{ini(c)}</button>
      <span className="sl-ppl-main">
        <button type="button" className="sl-ppl-name" onClick={() => openContact(c)} title="Open in Contacts">{name(c)}{c.is_billing && <em>Billing</em>}</button>
        {(c.position || company) && (
          <small>
            {c.position}{c.position && company ? " · " : ""}
            {company && <button type="button" className="sl-ppl-colink" onClick={openCompany} title="Open in Companies">{company.name}</button>}
          </small>
        )}
        {(c.phone || c.email || c.linkedin) && (
          <span className="sl-ppl-acts">
            {c.phone && <a className="sl-ppl-act" href={telOf(c.phone)} title={`Call ${c.phone}`}><QlIco n="phone" s={12} />{c.phone}</a>}
            {c.email && <a className="sl-ppl-act is-icon" href={`mailto:${c.email}`} title={c.email}><QlIco n="mail" s={13} /></a>}
            {c.linkedin && <a className="sl-ppl-act is-icon is-li" href={c.linkedin} target="_blank" rel="noreferrer" title="LinkedIn"><QlIco n="linkedin" s={12} /></a>}
          </span>
        )}
      </span>
      <span className="sl-ppl-side">
        <LinksMenu links={contactLinks(c)} label={`Links for ${name(c)}`} />
        {inDeal
          ? <button className="sl-ppl-x" onClick={() => onChange(dealIds.filter((x) => x !== c.id))} title="Take off this deal" aria-label={`Take ${name(c)} off this deal`}>×</button>
          : <button className="sl-ppl-add" onClick={() => onChange([...dealIds, c.id!])}>+ Add</button>}
      </span>
    </div>
  );
  return (
    <FoldPanel className="sl-panel-people" title="Contacts" count={onDeal.length}
      summary={onDeal.length
        ? onDeal.slice(0, 2).map(name).join(", ") + (onDeal.length > 2 ? ` +${onDeal.length - 2}` : "")
        : others.length ? `None yet · ${others.length} at the company` : "None yet"}
      aside={company && (
        <span className="sl-ppl-cohead">
          <button type="button" className="sl-ppl-co" onClick={openCompany} title="Open in Companies"><QlIco n="building" s={12} />{company.name}</button>
          <LinksMenu links={companyLinks} label={`Links for ${company.name}`} />
        </span>
      )}>
      {onDeal.length === 0 && <p className="sl-hint">No contacts on this deal yet{others.length ? " — add one from the company below." : "."}</p>}
      <div className="sl-ppl-list">{onDeal.map((c, i) => row(c, true, i))}</div>
      {others.length > 0 && (
        <>
          <span className="sl-ppl-sep">Also at {company?.name ?? "the company"}</span>
          <div className="sl-ppl-list">{othersShown.map((c, i) => row(c, false, i))}</div>
          {others.length > 3 && <button className="sl-ppl-more" onClick={() => setShowAll((v) => !v)}>{showAll ? "Show fewer" : `Show all ${others.length}`}</button>}
        </>
      )}
    </FoldPanel>
  );
}

export default function TrackingDetail({ tracking, companies, contacts, products, employees, trackingFields = [], salesRoles = [], startWithClient = false, onBack }: {
  tracking: Tracking; companies: Company[]; contacts: Contact[]; products: Product[]; employees: Employee[];
  /** Custom deal fields, shown in the Details card. */
  trackingFields?: TrackingField[];
  /** Sales roles: moving the deal past a role's last phase hands it over. */
  salesRoles?: SalesRole[];
  /** Just dropped on Won from the board and the user chose to create the client: open its form. */
  startWithClient?: boolean;
  onBack: () => void;
}) {
  const navigate = useNavigate();
  const [pendingHandover, setPendingHandover] = useState<{ plan: HandoverPlan; phaseId: string } | null>(null);
  const inactive = useInactiveIds(); // laid-off people aren't offered for the team or @mentions
  // Browser Back returns to the Sales overview instead of leaving the page.
  useBackToClose(`sales-deal-${tracking.id}`, onBack);
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
  /** The catalogue roles (Main Consultant, Project Manager, Connector…), to name a service's rates. */
  const [clientRoles, setClientRoles] = useState<ClientRole[]>([]);
  useEffect(() => { loadRoles().then(setClientRoles).catch(() => {}); }, []);
  const [potentials, setPotentials] = useState<PotentialService[]>([]);
  const [tprods, setTProds] = useState<TrackingProduct[]>([]);
  const [calcFor, setCalcFor] = useState<{ kind: "product" | "service"; id: string } | null>(null);
  const [revErr, setRevErr] = useState<string | null>(null);
  const [allPipelines, setAllPipelines] = useState<Pipeline[]>([]);
  const [team, setTeam] = useState<string[]>([]);
  const [owner, setOwner] = useState<string | null>(null);
  /** The sales role each person plays on this deal (when they have several). */
  const [dealRoles, setDealRoles] = useState<Record<string, string>>(tracking.deal_roles ?? {});
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
  /** Deal details, revenue, documents, notes and tasks shown in the handoff panel. */
  const [confirmExtras, setConfirmExtras] = useState<HandoffExtras | null>(null);
  const [trackingContactIds, setTrackingContactIds] = useState<string[]>([]);
  useEffect(() => { loadTrackingContactIds(tracking.id).then(setTrackingContactIds).catch(() => {}); }, [tracking.id]);
  const [clientCatalog, setClientCatalog] = useState<Product[]>([]);
  const [clientFormMode, setClientFormMode] = useState<"create" | "attach">("create"); // "attach" = scenario C
  /** The deal was just won and its client isn't set up: offer to create it now. */
  const [wonPrompt, setWonPrompt] = useState(false);
  /** The client was created from the won prompt: say so and point at the handoff. */
  const [clientDone, setClientDone] = useState(false);
  const [clientBusy, setClientBusy] = useState(false);
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
    // Opened from "deal won": the client is ready; the handoff is sent later.
    if (!pendingHandoff) { setClientDone(true); return; }
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
    if (!pendingHandoff) { setClientDone(true); return; }

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
      // Meetings deleted or cancelled in Outlook disappear here too.
      syncDeletedMeetingsFromOutlook(tracking.id, m).then(dropGoneMeetings).catch(() => {});
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
  /** The day it was actually closed (won / lost). The database stamps it when the status changes; we mirror that here. */
  const [closedOn, setClosedOn] = useState<string>(tracking.close_date ?? "");
  const prevStatus = useRef(tracking.status);
  useEffect(() => {
    const was = prevStatus.current; prevStatus.current = status;
    if (was === status) return;
    const closed = (x: string) => x === "won" || x === "lost";
    if (closed(status) && !closed(was) && !closedOn) { const d = new Date().toISOString().slice(0, 10); setClosedOn(d); tracking.close_date = d; }
    if (!closed(status) && closed(was)) { setClosedOn(""); tracking.close_date = null; }
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const pickDealRole = async (id: string, roleId: string) => {
    const next = { ...dealRoles, [id]: roleId };
    setDealRoles(next);
    const err = await saveDealRoles(tracking.id, next);
    if (err) window.alert(`Couldn't save the role: ${err}`);
  };
  const describeDealRole = (r: SalesRole): string | null => {
    const sc = r.scopes.find((x) => x.pipeline_id === tracking.pipeline_id);
    if (!sc) return null;
    const ph = orderPhases(phases).find((x) => x.id === sc.max_phase_id);
    const reach = sc.max_phase_id ? `Sees it up to ${ph?.name ?? "a set phase"}` : "Sees it in every phase";
    const to = sc.handover_to ? employees.find((e) => e.id === sc.handover_to)?.name : null;
    return to && sc.max_phase_id ? `${reach}, then it goes to ${to}` : reach;
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
  // The deal's own name (optional) — otherwise it's shown with the client's name.
  const [dealName, setDealNameState] = useState<string>(tracking.deal_name ?? "");
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const [nameErr, setNameErr] = useState<string | null>(null);
  const clientTitle = company?.name || (tracking.contactIds[0] ? contactName(tracking.contactIds[0]) : "Untitled");
  const title = dealName.trim() || clientTitle;
  const saveDealName = async () => {
    if (nameEdit === null) return;
    const v = nameEdit.replace(/\s+/g, " ").trim();
    const next = v === clientTitle ? "" : v;
    setNameEdit(null);
    if (next === dealName.trim()) return;
    const prev = dealName;
    setDealNameState(next); setNameErr(null);
    const err = await setDealName(tracking.id, next);
    if (err) { setDealNameState(prev); setNameErr(/deal_name/.test(err) ? "Run empower_deal_name.sql in Supabase to name deals." : err); }
  };

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
    // The version on screen of each line comes first; the others (proposals)
    // can be picked in the handoff panel. The signing date is set there.
    const source = ids.size ? activePotentials.filter((p) => ids.has(svcKey(p))) : activePotentials;
    const card = (p: PotentialService, label: string, group: string): ConfirmService => ({
      key: p.id,
      serviceId: p.service_id ?? "",
      name: p.label || serviceName(p.service_id),
      line: { ...(p as any) },
      calculator: (serviceOf(p.service_id)?.calculator as Calculator | null) ?? null,
      unit: (serviceUnit(p.service_id) === "hour" ? "hour" : "day"),
      minUnit: serviceMin(p.service_id),
      signingDate: wonDay(),
      contactIds: (((p as any).contact_ids ?? []) as string[]),
      group, versionLabel: label,
    });
    return source.map((p) => {
      const group = p.version_group ?? p.id;
      const grp = groupOf(potentials, group) as PotentialService[];
      const alts = grp.map((v, i) => card(v, `v${i + 1}`, group));
      return { ...card(p, `v${Math.max(0, grp.findIndex((x) => x.id === p.id)) + 1}`, group), alts };
    });
  };
  /** The deal's products with every version, for the handoff panel. */
  const confirmProductCards = (): ConfirmProduct[] => activeTprods.filter((tp) => tp.product_id).map((tp) => {
    const group = tp.version_group ?? tp.id;
    const grp = groupOf(tprods, group) as TrackingProduct[];
    const one = (v: TrackingProduct, i: number) => {
      const prod = productOf(v.product_id);
      return {
        key: v.id, group, productId: v.product_id as string, name: productName(v.product_id), line: { ...(v as any) },
        calculator: (prod?.calculator as Calculator | null) ?? null,
        catalogBase: prod?.tiers?.find((x) => x.id === v.tier_id)?.price,
        versionLabel: `v${i + 1}`,
      };
    };
    const alts = grp.map(one);
    return { ...one(tp, Math.max(0, grp.findIndex((x) => x.id === tp.id))), alts };
  });

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
  // Correct the day a phase was reached by hand (clicking a phase still stamps today).
  const [dateEdit, setDateEdit] = useState<string | null>(null);
  const dateAnchor = useRef<HTMLElement | null>(null);
  const changePhaseDate = async (phaseId: string, day: string) => {
    if (!day) return;
    const iso = new Date(`${day}T12:00:00`).toISOString();
    const ev = await setPhaseEntryDate(tracking.id, phaseId, iso);
    setEvents((xs) => {
      const rest = xs.filter((x) => x.phase_id !== phaseId);
      return [...rest, ev ?? { id: `tmp-${phaseId}`, phase_id: phaseId, entered_at: iso }];
    });
  };

  // Move to a phase. Past the last phase a sales role sees, the deal is handed
  // over first (double confirmation); otherwise it just moves.
  const applyPhase = async (id: string) => {
    if (id === curPhase) return;
    const plan = planHandover({ roles: salesRoles, pipelineId: tracking.pipeline_id, phases, fromPhaseId: curPhase, toPhaseId: id, owner, team, dealRoles });
    if (plan) { setPendingHandover({ plan, phaseId: id }); return; }
    await movePhase(id);
  };
  const confirmHandover = async () => {
    const p = pendingHandover;
    if (!p) return;
    const err = await performHandover(tracking.id, p.plan, {
      phase_id: curPhase, status, total: totalPotential,
      rep_close_prob: repProb, mgr_close_prob: mgrProb, rep_close_date: repDate || null, mgr_close_date: mgrDate || null,
      custom: tracking.custom ?? {},
    });
    if (err) { window.alert(`Couldn't hand the deal over: ${err}`); return; }
    setOwner(p.plan.toProfile);
    setTeam((t) => (t.includes(p.plan.toProfile) ? t : [...t, p.plan.toProfile]));
    await movePhase(p.phaseId);
    setPendingHandover(null);
    // Whoever handed it over no longer sees it live: back to the overview.
    if (me && !canAssign && p.plan.fromIds.includes(me.id)) onBack();
  };

  // Move to a phase, syncing status from the phase's outcome.
  const movePhase = async (id: string) => {
    const newIdx = phases.findIndex((p) => p.id === id);
    setCurPhase(id);
    await setTrackingPhase(tracking.id, id);
    // Keep entry dates only up to and including the new current phase; clear later ones.
    const keepIds = phases.slice(0, newIdx + 1).map((p) => p.id);
    const e = await stampPhaseEntry(tracking.id, id);
    await clearPhaseEventsAfter(tracking.id, keepIds);
    // Phases jumped over (first → last, say) take the same date as the one the deal landed on.
    const landedAt = e?.entered_at ?? events.find((x) => x.phase_id === id)?.entered_at ?? new Date().toISOString();
    const have = new Set(events.map((x) => x.phase_id));
    const gaps = phases.slice(0, newIdx).filter((p) => !p.sales_outcome && !have.has(p.id)).map((p) => p.id);
    const filled = await fillPhaseEntries(tracking.id, gaps, landedAt).catch(() => [] as PhaseEvent[]);
    setEvents((xs) => {
      let next = xs.filter((ev) => ev.phase_id && keepIds.includes(ev.phase_id));
      if (e && !next.find((x) => x.phase_id === id)) next = [...next, e];
      filled.forEach((f) => { if (!next.find((x) => x.phase_id === f.phase_id)) next = [...next, f]; });
      return next;
    });
    const ph = phases.find((p) => p.id === id);
    const next = ph?.sales_outcome === "win" ? "won" : ph?.sales_outcome === "loss" ? "lost" : "active";
    const wasWon = status === "won";
    setStatus(next); await setTrackingStatus(tracking.id, next);
    if (next === "lost") setLossModal(true);
    // Just won: if the client isn't set up yet, ask to create it right away.
    if (next === "won" && !wasWon && await clientNeeded().catch(() => false)) setWonPrompt(true);
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
      .filter((e) => !inactive.has(e.id))
      .map((e) => ({ id: `employee:${e.id}`, name: niceName(e.name), kind: "employee" as const }))
      .filter((e) => e.name);
    const linked: MentionPerson[] = contacts
      .filter((c) => companyContactIds.includes(c.id!))
      .map((c) => ({ id: `contact:${c.id}`, name: [c.first_name, c.last_name].filter(Boolean).join(" "), kind: "contact" }));
    return [...emps, ...linked];
  }, [employees, contacts, companyContactIds, inactive]);

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

  // New task: a name, an optional description, priority, quick/process and when it's due.
  const [newTask, setNewTask] = useState("");
  const [newTaskDesc, setNewTaskDesc] = useState("");
  const [taskPrio, setTaskPrio] = useState<TaskPriority>("normal");
  const [taskKind, setTaskKind] = useState<TaskKind>("quick");
  const [taskDue, setTaskDue] = useState("");        // date "YYYY-MM-DD"
  const [taskDueTime, setTaskDueTime] = useState("18:00");
  /** Steps and template of a task started from a predefined one (Settings → Tasks). */
  const [taskFrom, setTaskFrom] = useState<{ template_id: string; checklist: TaskStep[] } | null>(null);
  const [taskTemplates, setTaskTemplates] = useState<TaskTemplate[]>([]);
  useEffect(() => { void loadTaskTemplates().then(setTaskTemplates); }, []);
  const resetTaskDraft = () => { setNewTask(""); setNewTaskDesc(""); setTaskPrio("normal"); setTaskKind("quick"); setTaskDue(""); setTaskDueTime("18:00"); setTaskFrom(null); };
  const pickTaskTemplate = (t: TaskTemplate) => {
    const f = fromTemplate(t);
    setNewTask(f.title); setNewTaskDesc(f.description); setTaskPrio(f.priority); setTaskKind(f.kind);
    if (f.due_at) { setTaskDue(f.due_at.slice(0, 10)); setTaskDueTime(f.due_at.slice(11, 16)); }
    setTaskFrom({ template_id: t.id, checklist: f.checklist });
  };
  const submitTask = async () => {
    if (!cleanMentions(newTask).trim() || !taskDue) return;
    const dueIso = `${taskDue}T${taskDueTime || "00:00"}:00`;
    const t = await addTask(tracking.id, curPhase, newTask.trim(), dueIso, {
      description: newTaskDesc, priority: taskPrio, kind: taskKind,
      checklist: taskFrom?.checklist ?? [], template_id: taskFrom?.template_id ?? null,
    });
    // @mentions in the name or the description tag those people.
    if (t) { setTasks((xs) => [...xs, t]); await persistFromText("task", t.id, `${newTask}\n${newTaskDesc}`); }
    resetTaskDraft();
  };
  const flipTask = async (t: TrackTask) => {
    const done = !t.done;
    const progress = t.progress ?? 0;
    setTasks((xs) => xs.map((x) => x.id === t.id ? {
      ...x, done, status: done ? "done" : progress > 0 && progress < 100 ? "in_progress" : "todo",
      progress: done ? 100 : progress === 100 ? 0 : progress,
    } : x));
    await toggleTask(t.id, done);
  };
  const removeTask = (id: string) => ask({ title: "Delete task", message: "This task will be permanently removed.", confirmLabel: "Delete task", onConfirm: async () => {
    const e = await deleteTask(id);
    if (e) { window.alert(e); return; }
    setTasks((xs) => xs.filter((t) => t.id !== id));
  } });
  /** Only whoever created a task can delete it. */
  const canDelete = (t: TrackTask) => canDeleteTask(t, me?.id);
  const editTask = async (id: string, raw: string, rawDesc?: string) => {
    const patch: { title: string; description?: string | null } = { title: raw.trim() };
    if (rawDesc !== undefined) patch.description = rawDesc.trim() || null;
    await updateTask(id, patch);
    setTasks((xs) => xs.map((t) => t.id === id ? { ...t, ...patch } : t));
    await persistFromText("task", id, `${raw}\n${rawDesc ?? ""}`);
  };
  // The task panel (same one as on Home): status, %, priority, progress notes.
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  /** The full-window task view, opened from the panel's ⤢ on this task. */
  const [taskWindow, setTaskWindow] = useState<MyTask | null>(null);
  const openTask = tasks.find((t) => t.id === openTaskId) ?? null;
  const asMyTask = (t: TrackTask): MyTask => ({
    ...t, tracking_id: tracking.id, deal: title, company: null, assigned: false,
    priority: t.priority ?? "normal", kind: t.kind ?? "quick",
    status: t.status ?? (t.done ? "done" : "todo"), progress: t.progress ?? (t.done ? 100 : 0), lastNote: null,
  });
  const editTaskDue = async (id: string, dueIso: string | null) => {
    await updateTask(id, { due_at: dueIso });
    setTasks((xs) => xs.map((t) => t.id === id ? { ...t, due_at: dueIso } : t));
  };
  // Overdue = has a deadline in the past and not done.
  const isOverdue = (t: TrackTask) => !t.done && !!t.due_at && new Date(t.due_at).getTime() < Date.now();
  const overdueCount = tasks.filter(isOverdue).length;
  const urgentCount = tasks.filter((t) => !t.done && t.priority === "urgent").length;

  // ---- Proposal generation (PPT / PDF) ----
  const [propMenu, setPropMenu] = useState(false);
  const [propBusy, setPropBusy] = useState<null | "pptx" | "pdf">(null);
  const [propErr, setPropErr] = useState<string | null>(null);
  const buildProposalData = (sel?: Record<string, { include: boolean; versionId: string }>, phaseOverride?: Record<string, { name: string; days: number; tasks: string[] }[]>,
    /** Filled with the catalogue ids of the products / services, in the order they come out. */
    ids?: { products: string[]; services: string[] }): ProposalData => {
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
      const tier = prod?.tiers?.find((x) => x.id === tp.tier_id);
      const base = tier?.price;
      const bd = lineBreakdown(tp, prod?.calculator as Calculator | null, base);
      ids?.products.push(tp.product_id ?? "");
      // The contract lengths the plan offers: price per year, before / after each length's discount.
      const annualGross = bd.unitPrice * (tp.recurring && tp.period === "monthly" ? 12 : 1);
      const durs = (tier?.durations ?? []).filter((d) => Number(d.months) > 0);
      const terms = (durs.length ? durs : [{ months: 12, discount_pct: 0 }]).map((d) => {
        const pct = Number(d.discount_pct) || 0;
        return { years: Math.round((Number(d.months) / 12) * 100) / 100, discountPct: pct, annualGross, annual: annualGross * (1 - pct / 100) };
      });
      return {
        terms,
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
      ids?.services.push(p.service_id ?? "");
      const unit = (serviceUnit(p.service_id) === "hour" ? "hour" : "day") as "hour" | "day";
      const ov = phaseOverride?.[`s:${vg}`];
      const rateRows = bd.rows.filter((r: any) => r.days && r.days > 0);
      const phases = ov
        ? ov.map((f) => ({ name: f.name, bullets: f.tasks ?? [], days: f.days }))
        : (rateRows.length ? rateRows.map((r: any) => ({ name: r.label, bullets: r.detail ? [r.detail] : [], days: r.days })) : [{ name: p.label || serviceName(p.service_id), bullets: [], days: bd.qty }]);
      // Who does the work: each calculator row's role (Settings), the rest goes to the service's main role.
      const svcRoles = svc?.roles ?? [];
      const mainRole = (svcRoles.find((r) => r.is_main) ?? svcRoles[0])?.role_id || "consultor";
      const varOf = (key: string) => (svc?.calculator as Calculator | null)?.variables.find((v) => (v.id ?? String(v.sort)) === key);
      const byRole = new Map<string, { name: string; days: number; amount: number }>();
      rateRows.forEach((r: any) => {
        const id = varOf(r.key)?.role_id || mainRole;
        const cur = byRole.get(id) ?? { name: roleNameOf(id, clientRoles), days: 0, amount: 0 };
        cur.days += Number(r.days) || 0; cur.amount += Number(r.amount) || 0;
        byRole.set(id, cur);
      });
      const roles = byRole.size
        ? Array.from(byRole.values()).map((r) => ({ name: r.name, days: r.days, rate: r.days ? r.amount / r.days : r.amount }))
        : [{ name: roleNameOf(mainRole, clientRoles), days: bd.qty, rate: bd.qty ? (bd.total + bd.discount) / bd.qty : bd.unitPrice }];
      return {
        roles,
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
  const runProposal = (kind: "pptx" | "pdf") => { propTarget.current = null; setPropMenu(false); setPropPick(kind); };

  /** The saved proposal being generated (its document is kept on the deal), or null for a one-off. */
  const propTarget = useRef<DealProposal | null>(null);
  const [propBusyId, setPropBusyId] = useState<string | null>(null);
  const [propsReload, setPropsReload] = useState(0);
  /** The built-in generator's template (Settings › Proposal template). */
  const templateFor = async (_sel: Record<string, { include: boolean; versionId: string }>, _pickedId?: string | null) => loadProposalTemplateFor(null, null);
  const generateWithSel = async (kind: "pptx" | "pdf", sel: Record<string, { include: boolean; versionId: string }>, phaseOverride?: Record<string, { name: string; days: number; tasks: string[] }[]>) => {
    const target = propTarget.current;
    propTarget.current = null;
    setPropBusy(kind); setPropErr(null);
    if (target) setPropBusyId(`${target.id}:${kind}`);
    try {
      const tpl = await templateFor(sel, target?.template_id);
      if (!tpl) { setPropErr("No proposal template configured for your company yet."); return; }
      const { blob, fileName } = await renderProposal(kind, buildProposalData(sel, phaseOverride), tpl.template, target?.name);
      downloadBlob(blob, fileName);
      if (target) {
        // Kept on the deal: it goes with the handoff into the client's folders.
        const { file, error } = await uploadTrackingFile(tracking.id, curPhase, blob, fileName, `Proposal · ${target.name}`);
        if (error || !file) { setPropErr(`Downloaded, but not saved on the deal: ${error ?? "unknown error"}`); return; }
        const f = proposalFigures(target.lines, proposalGroups);
        const { error: e2 } = await saveDealProposal({ ...target, file_id: file.id, gross: f.gross, partner: f.partner, total: f.total, is_main: undefined });
        if (e2) setPropErr(e2);
        setPropsReload((n) => n + 1);
      }
    } catch (e: any) { setPropErr(e?.message ?? "Could not generate the proposal."); }
    finally { setPropBusy(null); setPropBusyId(null); }
  };
  /** Generate a saved proposal: its versions, the lines it leaves out excluded. */
  /** A saved proposal as a selection: its versions; lines it leaves out, and lines kept out of proposals, excluded. */
  const selOfProposal = (p: DealProposal) => {
    const sel: Record<string, { include: boolean; versionId: string }> = {};
    allProposalGroups.forEach((g) => {
      const visible = proposalGroups.includes(g);
      const l = p.lines.find((x) => x.kind === g.kind && x.group === g.group);
      const ok = visible && !!l?.line && g.versions.some((v) => v.id === l.line);
      sel[`${g.kind === "product" ? "p" : "s"}:${g.group}`] = { include: ok, versionId: ok ? l!.line! : g.activeId ?? "" };
    });
    return sel;
  };
  const generateProposalFor = (p: DealProposal, kind: "pptx" | "pdf") => {
    propTarget.current = p;
    doGenerate(kind, selOfProposal(p));
  };

  /** Each included service's phases, from its blueprint (days spread by the blueprint's %). */
  const blueprintPhases = async (sel: Record<string, { include: boolean; versionId: string }>) => {
    const picked = Array.from(new Set(potentials.map((p) => p.version_group ?? p.id)))
      .filter((vg) => sel[`s:${vg}`]?.include !== false)
      .map((vg) => (groupOf(potentials, vg as string).find((x) => x.id === sel[`s:${vg}`]?.versionId)) || activeOfGroup(potentials, vg as string))
      .filter(Boolean) as any[];
    const ids = Array.from(new Set(picked.map((p) => p.service_id).filter(Boolean)));
    const out: Record<string, { name: string; days: number; tasks: string[] }[]> = {};
    if (!ids.length) return out;
    const bps = await loadBlueprintsForServices(ids).catch(() => ({} as Record<string, PhaseBlueprint>));
    picked.forEach((p) => {
      const bp = p.service_id ? bps[p.service_id] : null;
      if (!bp?.phases?.length) return;
      const totalDays = lineBreakdown(p, serviceOf(p.service_id)?.calculator as Calculator | null, undefined, serviceMin(p.service_id)).qty;
      const minUnit = serviceMin(p.service_id) || 0.5;
      out[`s:${p.version_group ?? p.id}`] = bp.phases.map((ph) => ({
        name: ph.name, days: billableQty((totalDays * (ph.percent || 0)) / 100, minUnit), tasks: (ph.tasks ?? []).map((tk) => tk.name),
      }));
    });
    return out;
  };

  // ---- Proposal decks (the company's own PowerPoint) ----
  const [decks, setDecks] = useState<ProposalDeckRow[] | null>(null);
  useEffect(() => { listProposalDecks().then(setDecks).catch(() => setDecks([])); }, []);
  const [studio, setStudio] = useState<null | { proposal: DealProposal; data: ProposalData; productIds: string[]; serviceIds: string[] }>(null);
  const openStudio = async (p: DealProposal) => {
    setPropBusyId(`${p.id}:studio`); setPropErr(null);
    try {
      const sel = selOfProposal(p);
      const phases = await blueprintPhases(sel);
      const ids = { products: [] as string[], services: [] as string[] };
      const data = buildProposalData(sel, phases, ids);
      setStudio({ proposal: p, data, productIds: ids.products, serviceIds: ids.services });
    } catch (e: any) { setPropErr(e?.message ?? "Could not open the proposal."); }
    finally { setPropBusyId(null); }
  };
  const seller = (() => { const e: any = employees.find((x) => x.id === me?.id); return { name: e?.name, email: e?.email, phone: e?.phone }; })();

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
  const [meetEnd, setMeetEnd] = useState("11:00");

  /**
   * Writing a note, task or meeting: that box gets the whole column and the
   * other two fold away until it's saved or cancelled. The last box typed in wins.
   */
  type Composer = "notes" | "tasks" | "meetings";
  const [composing, setComposing] = useState<Composer | null>(null);
  const drafts: Record<Composer, boolean> = {
    notes: !!cleanMentions(newNote).trim(),
    tasks: !!cleanMentions(newTask).trim(),
    meetings: !!cleanMentions(meetTitle).trim(),
  };
  const lastDrafts = useRef(drafts);
  useEffect(() => {
    const prev = lastDrafts.current;
    lastDrafts.current = drafts;
    const started = (Object.keys(drafts) as Composer[]).find((k) => drafts[k] && !prev[k]);
    if (started) { setComposing(started); return; }
    setComposing((cur) => (cur && drafts[cur] ? cur : (Object.keys(drafts) as Composer[]).find((k) => drafts[k]) ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts.notes, drafts.tasks, drafts.meetings]);
  const cancelComposer = (k: Composer) => {
    if (k === "notes") setNewNote("");
    if (k === "tasks") resetTaskDraft();
    if (k === "meetings") { setMeetTitle(""); setMeetDate(""); setMeetTime("10:00"); setMeetEnd("11:00"); }
  };
  const panelState = (k: Composer) => (composing ? (composing === k ? " is-composing" : " is-folded") : "");
  const composeCancel = (k: Composer) => composing === k && (
    <button type="button" className="sl-compose-x" onClick={() => cancelComposer(k)} title="Discard and show everything again">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      Cancel
    </button>
  );
  const [meetKind, setMeetKind] = useState<MeetingKind>("in_person");
  // Outlook: what happened to the meeting just booked (shown under Schedule).
  const [meetSync, setMeetSync] = useState<{ id: string; state: "syncing" | "ok" | "err" | "gone"; msg?: string; invited?: number; teams?: "yes" | "skipped" | null; count?: number } | null>(null);
  /** Meetings deleted / cancelled in Outlook: off the list, with a short note saying why. */
  const dropGoneMeetings = (ids: string[]) => {
    if (!ids.length) return;
    const gone = new Set(ids);
    setMeetings((xs) => xs.filter((m) => !gone.has(m.id)));
    setMeetSync({ id: ids[0], state: "gone", count: ids.length });
  };
  // Back from Outlook (tab focused again): check whether any meeting was deleted there.
  const meetingsRef = useRef(meetings);
  meetingsRef.current = meetings;
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== "visible") return;
      syncDeletedMeetingsFromOutlook(tracking.id, meetingsRef.current).then(dropGoneMeetings).catch(() => {});
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracking.id]);
  useEffect(() => {
    const on = (e: Event) => {
      const { id, result } = (e as CustomEvent).detail ?? {};
      if (result?.gone) { dropGoneMeetings([id]); return; }
      setMeetings((xs) => xs.map((m) => m.id === id
        ? { ...m, outlook_event_id: result?.eventId ?? m.outlook_event_id ?? null, outlook_error: result?.ok ? null : result?.notMine ? null : result?.error ?? null, outlook_syncing: false }
        : m));
      setMeetSync((cur) => (!cur || cur.id !== id ? cur : result?.ok
        ? { id, state: "ok", invited: result.invited ?? 0, teams: result.joinUrl ? "yes" : result.teamsSkipped ? "skipped" : null }
        : result?.notMine ? null : { id, state: "err", msg: result?.error }));
    };
    window.addEventListener(MEETING_OUTLOOK_EVENT, on);
    return () => window.removeEventListener(MEETING_OUTLOOK_EVENT, on);
  }, []);
  useEffect(() => {
    if (meetSync?.state !== "ok" && meetSync?.state !== "gone") return;
    const t = setTimeout(() => setMeetSync((cur) => (cur?.state === "ok" || cur?.state === "gone" ? null : cur)), 8000);
    return () => clearTimeout(t);
  }, [meetSync]);
  const retryOutlook = (id: string) => {
    setMeetSync({ id, state: "syncing" });
    setMeetings((xs) => xs.map((m) => (m.id === id ? { ...m, outlook_syncing: true, outlook_error: null } : m)));
    void syncMeetingToOutlook(id);
  };
  const submitMeeting = async () => {
    if (!cleanMentions(meetTitle).trim() || !meetDate) return;
    if (!spanOk(meetTime, meetEnd)) return;
    const iso = `${meetDate}T${meetTime || "00:00"}:00`;
    const m = await addMeeting(tracking.id, curPhase, meetTitle.trim(), iso, meetKind, `${meetDate}T${meetEnd}:00`);
    if (m) { setMeetSync({ id: m.id, state: "syncing" }); setMeetings((xs) => [...xs, m]); await persistFromText("meeting", m.id, meetTitle); }
    setMeetTitle(""); setMeetDate(""); setMeetTime("10:00"); setMeetEnd("11:00");
  };
  const removeMeeting = (id: string) => {
    const m = meetings.find((x) => x.id === id);
    ask({
      title: "Delete meeting",
      message: m?.outlook_event_id ? "This meeting will be removed here and from Outlook." : "This meeting will be permanently removed.",
      confirmLabel: "Delete meeting",
      onConfirm: async () => {
        setMeetings((xs) => xs.filter((x) => x.id !== id));
        setMeetSync((cur) => (cur?.id === id ? null : cur));
        await deleteMeeting(id);
      },
    });
  };
  /** Save an edited meeting: text and/or new day, start and end — one update, one Outlook sync. */
  const editMeeting = async (id: string, raw: string, meetAt?: string | null, endAt?: string | null) => {
    const old = meetings.find((m) => m.id === id);
    const title = raw.trim();
    const titleChanged = !!title && title !== old?.title;
    const moved = (!!meetAt && meetAt !== old?.meet_at) || (!!endAt && endAt !== old?.end_at);
    if (!titleChanged && !moved) return;
    await updateMeeting(id, { ...(titleChanged ? { title } : {}), ...(moved ? { meet_at: meetAt ?? old?.meet_at ?? null, end_at: endAt ?? null } : {}) });
    setMeetings((xs) => xs.map((m) => (m.id === id ? { ...m, ...(titleChanged ? { title } : {}), ...(moved ? { meet_at: meetAt ?? m.meet_at, end_at: endAt ?? m.end_at } : {}), outlook_syncing: !!m.mine } : m))
      .sort((a, b) => (a.meet_at ?? "").localeCompare(b.meet_at ?? "")));
    if (titleChanged) await persistFromText("meeting", id, raw);
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
    // A duration calculator bills each role's time at that role's rate, so the
    // line's own rate is the main role's. Flat services keep the sum of their roles.
    const main = svc?.roles?.find((r) => r.is_main) ?? svc?.roles?.[0];
    const price = svc?.calculator?.output_kind === "quantity" && main
      ? Number(main.price) || 0
      : svc?.roles?.reduce((sum: number, r: any) => sum + (r.price || 0), 0) ?? 0;
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
  /** The version that counts; none when every version is off (left out by the main proposal). */
  const activeOfGroup = (list: any[], vg: string | null | undefined) => {
    const g = groupOf(list, vg);
    if (g.length && g.every((x) => x.version_active === false)) return undefined;
    return g.find((x) => x.version_active) ?? g[g.length - 1];
  };
  /** Line groups left out of the deal (every version off), to show and bring back. */
  const leftOutGroups = (list: any[]) => Array.from(new Set(list.map((x) => x.version_group ?? x.id)))
    .filter((vg) => !activeOfGroup(list, vg)).map((vg) => ({ vg, rows: groupOf(list, vg) }));
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

  /**
   * Everything else on the deal for the handoff panel: details, the revenue
   * lines as sold, every document (version proposals included), notes, tasks,
   * and the client's own folders to file documents into.
   */
  const buildHandoffExtras = async (): Promise<HandoffExtras> => {
    const phaseName = (id: string | null | undefined) => (id ? allPhases.find((p) => p.id === id)?.name ?? null : null);
    const [files, fresh, cl] = await Promise.all([
      loadAllTrackingFiles(tracking.id).catch(() => []),
      supabase.from("trackings").select("custom").eq("id", tracking.id).maybeSingle().then((r) => (r.data as any)?.custom ?? tracking.custom ?? {}, () => tracking.custom ?? {}),
      tracking.company_id ? supabase.from("clients").select("id").eq("company_id", tracking.company_id).limit(1).then((r) => (r.data ?? [])[0] as any) : Promise.resolve(null),
    ]);
    let folders: string[] = [];
    if (cl?.id) {
      const { data } = await supabase.from("client_folders").select("name").eq("client_id", cl.id).is("parent_id", null).order("sort");
      folders = ((data ?? []) as any[]).map((f) => String(f.name));
    }
    const pct = (n: number | null) => (n == null ? "" : `${n}%`);
    const day = (d: string | null | undefined) => (d ? new Date(d.length === 10 ? `${d}T12:00:00` : d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");
    const customVal = (f: TrackingField) => {
      const v = (fresh as any)?.[f.id];
      if (v == null || v === "") return "";
      if (f.type === "boolean") return v ? "Yes" : "No";
      if (f.type === "date") return day(String(v));
      return String(v);
    };
    const fields = [
      { label: "Deal", value: dealName || company?.name || "" },
      { label: "Pipeline", value: allPipelines.find((p) => p.id === tracking.pipeline_id)?.name ?? "" },
      { label: "Phase", value: phaseName(curPhase) ?? "" },
      { label: "Status", value: statusText(status) },
      { label: "Owner", value: owner ? empName(owner) : "" },
      { label: "Team", value: team.map(empName).join(", ") },
      { label: "Deal contacts", value: trackingContactIds.map(contactName).filter(Boolean).join(", ") },
      { label: "Close probability (rep)", value: pct(repProb) },
      { label: "Close probability (manager)", value: pct(mgrProb) },
      { label: "Expected close (rep)", value: day(repDate) },
      { label: "Expected close (manager)", value: day(mgrDate) },
      { label: "Closed on", value: day(closedOn) },
      { label: "Created", value: day(tracking.created_at) },
      ...trackingFields.map((f) => ({ label: f.label, value: customVal(f) })),
    ].filter((f) => f.value);

    const revOf = (l: any, kind: "product" | "service") => {
      const calc = (kind === "product" ? productOf(l.product_id)?.calculator : serviceOf(l.service_id)?.calculator) as Calculator | null;
      const base = kind === "product" ? productOf(l.product_id)?.tiers?.find((x) => x.id === l.tier_id)?.price : undefined;
      const bd = lineBreakdown(l, calc, base, kind === "service" ? serviceMin(l.service_id) : undefined);
      const grp = groupOf(kind === "product" ? tprods : potentials, l.version_group ?? l.id);
      const unit = kind === "service" ? (serviceUnit(l.service_id) === "hour" ? "hours" : "days") : "";
      const summary = l.recurring
        ? `${money(bd.unitPrice)} per ${l.period === "monthly" ? "month" : "year"} ${bd.multiplierLabel ?? ""}`.trim()
        : kind === "service" ? `${bd.qty} ${unit}` : `${money(bd.unitPrice)} x ${Number(l.quantity ?? 1)}`;
      return {
        key: l.id, kind, label: kind === "product" ? productName(l.product_id) : (l.label || serviceName(l.service_id)),
        total: bd.total, gross: bd.gross, discount: bd.discount, summary,
        version: grp.length > 1 ? `v${grp.findIndex((x) => x.id === l.id) + 1} of ${grp.length}` : "",
        rows: bd.rows.map((r) => ({ label: r.label, detail: r.detail, amount: r.amount, discount: r.discount })),
      };
    };
    const revenue = [...activeTprods.map((l) => revOf(l, "product")), ...activePotentials.map((l) => revOf(l, "service"))];

    const docs: HandoffDoc[] = files.map((f): HandoffDoc => {
      const base = { id: f.id, name: f.name, mime: f.mime, size: f.size_bytes, note: f.note, created_at: f.created_at, bucket: "tracking-files", path: f.storage_path };
      if (!f.line_id) return { ...base, group: "deal" as const };
      const prod = tprods.find((x) => x.id === f.line_id);
      const svc = prod ? null : potentials.find((x) => x.id === f.line_id);
      const line: any = prod ?? svc;
      if (!line) return { ...base, group: "revenue" as const, lineLabel: "Removed line", active: false };
      const kind = prod ? "product" as const : "service" as const;
      const list: any[] = prod ? tprods : potentials;
      const grp = groupOf(list, line.version_group ?? line.id);
      const live = activeOfGroup(list, line.version_group ?? line.id);
      return {
        ...base, group: "revenue" as const, kind,
        lineLabel: prod ? productName(line.product_id) : (line.label || serviceName(line.service_id)),
        version: `v${grp.findIndex((x) => x.id === line.id) + 1}`, active: live?.id === line.id,
      };
    }).sort((a, b) => (a.lineLabel ?? "").localeCompare(b.lineLabel ?? "") || (a.version ?? "").localeCompare(b.version ?? ""));

    return {
      deal: { title: dealName || company?.name || "Deal", fields },
      revenue, docs, folders,
      notes: notes.map((n) => ({ id: n.id, body: n.body, created_at: n.created_at, author: n.created_by ? empName(n.created_by) : null, phase: phaseName(n.phase_id) })),
      tasks: tasks.map((t) => ({ id: t.id, title: t.title, description: t.description ?? null, done: t.done, due_at: t.due_at ?? null, status: t.status ?? null, priority: t.priority ?? null, phase: phaseName(t.phase_id) })),
    };
  };
  // Load the extras whenever the handoff panel opens (whichever path opened it).
  useEffect(() => {
    if (!confirmOpen) { setConfirmExtras(null); return; }
    let alive = true;
    buildHandoffExtras().then((x) => { if (alive) setConfirmExtras(x); }).catch((e) => {
      console.error("handoff extras failed:", e);
      if (alive) setConfirmExtras({ deal: { title: "", fields: [] }, revenue: [], docs: [], notes: [], tasks: [], folders: [] });
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmOpen]);

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
  const servicesTotal = activePotentials.reduce(
    (s, p) => s + lineTotal(p, serviceOf(p.service_id)?.calculator as Calculator | null, undefined, serviceMin(p.service_id)), 0);
  const totalPotential = productsTotal + servicesTotal;
  /** What partners take from the active lines (already out of the totals above). */
  const partnersTotal = [
    ...activeTprods.map((p) => lineBreakdown(p, productOf(p.product_id)?.calculator as Calculator | null, productOf(p.product_id)?.tiers?.find((x) => x.id === p.tier_id)?.price).partner),
    ...activePotentials.map((p) => lineBreakdown(p, serviceOf(p.service_id)?.calculator as Calculator | null, undefined, serviceMin(p.service_id)).partner),
  ].reduce((a, b) => a + b, 0);
  /** Every line group with its versions, for building proposals. */
  const allProposalGroups: PropGroup[] = [
    ...Array.from(new Set(tprods.map((p) => p.version_group ?? p.id))).map((vg): PropGroup => {
      const grp = groupOf(tprods, vg); const act = activeOfGroup(tprods, vg);
      return {
        kind: "product", group: vg, name: productName(grp[0]?.product_id ?? null), activeId: act?.id ?? null,
        ownerKey: grp[0]?.product_id ? `product:${grp[0].product_id}` : null,
        versions: grp.map((v, i) => {
          const prod = productOf(v.product_id);
          const bd = lineBreakdown(v, prod?.calculator as Calculator | null, prod?.tiers?.find((x) => x.id === v.tier_id)?.price);
          return { id: v.id, label: `v${i + 1}`, total: bd.total, partner: bd.partner, net: bd.net };
        }),
      };
    }),
    ...Array.from(new Set(potentials.map((p) => p.version_group ?? p.id))).map((vg): PropGroup => {
      const grp = groupOf(potentials, vg); const act = activeOfGroup(potentials, vg);
      return {
        kind: "service", group: vg, name: grp[0]?.label || serviceName(grp[0]?.service_id ?? null), activeId: act?.id ?? null,
        ownerKey: grp[0]?.service_id ? `service:${grp[0].service_id}` : null,
        versions: grp.map((v, i) => {
          const bd = lineBreakdown(v, serviceOf(v.service_id)?.calculator as Calculator | null, undefined, serviceMin(v.service_id));
          return { id: v.id, label: `v${i + 1}`, total: bd.total, partner: bd.partner, net: bd.net };
        }),
      };
    }),
  ];
  /** The groups proposals can use: products / services switched off for proposals (catalogue) stay out of them. */
  const proposalGroups = allProposalGroups.filter((g) => {
    const id = g.ownerKey?.split(":")[1];
    const item: any = id ? (g.kind === "product" ? productOf(id) : serviceOf(id)) : null;
    return item?.in_proposals !== false;
  });
  /** A proposal became the main one: show its versions as the active ones. */
  const applyMainLocally = (p: DealProposal) => {
    // undefined = not in the proposal (left as is); null = left out (every version off).
    const pick = (kind: "product" | "service", vg: string) => { const l = p.lines.find((x) => x.kind === kind && x.group === vg); return l ? (l.line ?? null) : undefined; };
    setTProds((xs) => xs.map((x) => { const id = pick("product", x.version_group ?? x.id); return id === undefined ? x : { ...x, version_active: x.id === id }; }));
    setPotentials((xs) => xs.map((x) => { const id = pick("service", x.version_group ?? x.id); return id === undefined ? x : { ...x, version_active: x.id === id }; }));
  };
  /** A line left out by the main proposal, back in (its newest version). */
  const includeGroup = (kind: "product" | "service", vg: string, rows: any[]) => {
    const last = rows[rows.length - 1]; if (!last) return;
    if (kind === "product") switchProdVersion(vg, last.id); else switchSvcVersion(vg, last.id);
  };
  const leftOutRows = (kind: "product" | "service", list: any[]) => {
    const out = leftOutGroups(list);
    if (!out.length) return null;
    return (
      <div className="sl-rv-out">
        {out.map(({ vg, rows }) => (
          <div key={vg} className="sl-rv-outrow">
            <span className="sl-rv-outname">{kind === "product" ? productName(rows[0]?.product_id ?? null) : (rows[0]?.label || serviceName(rows[0]?.service_id ?? null))}</span>
            <em>Left out by the main proposal</em>
            <button type="button" className="sl-rv-tool" onClick={() => includeGroup(kind, vg, rows)}>Include</button>
          </div>
        ))}
      </div>
    );
  };
  const money = (n: number) =>
    `\u20ac${(Number(n) || 0).toLocaleString("de-DE", { maximumFractionDigits: 0 })}`;

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

  /**
   * What each destination receives: the products and services listed on the
   * handoff phase that points at that pipeline, priced from the calculator.
   */
  const destinationsFor = (picked: { id: string; name: string; items?: any[] }[], pots: PotentialService[], prods: TrackingProduct[] = activeTprods) => picked.map((tg) => {
      const ids = new Set((tg.items ?? []).map((it: any) => it.id));
      const lines: any[] = [];

      prods.filter((tp) => tp.product_id && ids.has(tp.product_id)).forEach((tp) => {
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

      pots.filter((p) => ids.has(svcKey(p))).forEach((p) => {
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
        // Each calculator variable is billed as a role (Settings); the rest of
        // the time, and the base row, go to the service's main role. Management
        // builds the project's role lines from this.
        const svcRoles = serviceOf(p.service_id)?.roles ?? [];
        const mainRole = (svcRoles.find((r) => r.is_main) ?? svcRoles[0])?.role_id || "consultor";
        const varOf = (key: string) => svcCalc?.variables.find((v) => (v.id ?? String(v.sort)) === key);
        const isSup = (key: string) => !varOf(key)?.role_id && !!varOf(key)?.is_supervision;
        // Legacy supervision rows (not migrated yet) travel as "supervision"; management maps it to its role.
        const roleOfRow = (key: string) => varOf(key)?.role_id || (isSup(key) ? "supervision" : mainRole);
        const rows = bd.rows.map((r) => {
          const tr = timeRows.find((x) => x.key === r.key);
          const d = tr ? tr.amount : undefined;
          const roleId = roleOfRow(r.key);
          return {
            label: r.label, detail: r.detail, amount: r.amount, discount: r.discount,
            days: d, rate: d && d > 0 ? Math.round(r.amount / d) : undefined,
            roleId, roleName: roleNameOf(roleId, clientRoles),
            supervision: isSup(r.key) || undefined,
          };
        });
        // Days and net money per role; the rate is what the role's rows earn per day.
        const acc = new Map<string, { days: number; net: number }>();
        const bump = (k: string, d: number, net: number) => {
          const a = acc.get(k) ?? { days: 0, net: 0 };
          a.days += d; a.net += net; acc.set(k, a);
        };
        if (svcCalc?.output_kind === "quantity") rows.forEach((r) => bump(r.roleId, r.days ?? 0, r.amount - r.discount));
        const rowDays = [...acc.values()].reduce((a, x) => a + x.days, 0);
        const mainAcc = acc.get(mainRole);
        const mainRate = mainAcc && mainAcc.days > 0 ? mainAcc.net / mainAcc.days : lineRate;
        if (!acc.size) bump(mainRole, days, bd.total);
        // Rounding up to the billable minimum adds days to the main role.
        const extra = acc.size && rowDays < days ? days - rowDays : 0;
        const roles = [...acc.entries()]
          .map(([roleId, a]) => {
            const isMain = roleId === mainRole;
            const d = a.days + (isMain ? extra : 0);
            const rate = isMain ? (a.days > 0 ? a.net / a.days : mainRate) : (a.days > 0 ? a.net / a.days : 0);
            return { roleId, days: Math.round(d * 100) / 100, rate: Math.round(rate) };
          })
          .filter((x) => x.days > 0);
        if (extra > 0 && !roles.some((x) => x.roleId === mainRole)) roles.unshift({ roleId: mainRole, days: Math.round(extra * 100) / 100, rate: Math.round(mainRate) });
        const supRows = rows.filter((r) => r.supervision && (r.days ?? 0) > 0);
        const supDays = supRows.reduce((a, r) => a + (r.days ?? 0), 0);
        lines.push({
          label: p.label || serviceName(p.service_id), kind: "service",
          price: Math.round(bd.total), days,
          gross: Math.round(bd.gross), discount: Math.round(bd.discount),
          rate: Math.round(lineRate),
          rows,
          roles,
          supervision_days: supDays || undefined,
          supervision_rate: supDays ? Math.round(supRows.reduce((a, r) => a + r.amount, 0) / supDays) : undefined,
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

  /** The day the deal was won: the default signing date of everything signed with it. */
  const wonDay = () => {
    const ev = winPhase ? events.find((x) => x.phase_id === winPhase.id)?.entered_at : null;
    return (closedOn || tracking.close_date || ev || new Date().toISOString()).slice(0, 10);
  };
  /** No client for this company yet, or it is buying products not on file yet. */
  const clientNeeded = async () => {
    if (!tracking.company_id) return false;
    if (!(await clientExistsForCompany(tracking.company_id))) return true;
    const tp = tprods.length ? tprods : await loadTrackingProducts(tracking.id).catch(() => [] as TrackingProduct[]);
    return tp.length > 0 && !(await hasClientProductsForTracking(tracking.id));
  };
  /**
   * Opens the client form when the client still has to be created (or the
   * deal's new products added to it). `destinations` set = the handoff waits
   * for it; null = opened on its own (deal won), nothing is sent.
   * Returns false when there was nothing to set up.
   */
  const openClientForm = async (destinations: { id: string; name: string; services: any[]; potential_value: number }[] | null) => {
    if (!tracking.company_id) return false;
    const signDay = wonDay();
    const exists = await clientExistsForCompany(tracking.company_id);
    if (!exists) {
      const [prefill, catalog] = await Promise.all([buildClientPrefill(tracking.company_id, tracking.id), listCatalogProducts()]);
      if (!prefill) return false;
      setClientCatalog(catalog);
      setPendingHandoff(destinations);
      setClientPrefill({ ...prefill, products: prefill.products.map((p: any) => ({ ...p, signingDate: signDay })) });
      setClientFormMode("create");
      setClientFormOpen(true);
      return true;
    }
    const tp = tprods.length ? tprods : await loadTrackingProducts(tracking.id).catch(() => [] as TrackingProduct[]);
    if (tp.length > 0 && !(await hasClientProductsForTracking(tracking.id))) {
      const [attach, catalog] = await Promise.all([buildAttachPrefill(tracking.company_id, tracking.id), listCatalogProducts()]);
      if (attach) {
        setClientCatalog(catalog as any);
        setPendingHandoff(destinations);
        setClientPrefill({ ...attach.prefill, products: attach.prefill.products.map((p: any) => ({ ...p, signingDate: signDay })) });
        setAttachClientId(attach.clientId);
        setClientFormMode("attach");
        setClientFormOpen(true);
        return true;
      }
    }
    return false;
  };
  const createClientNow = async () => {
    setClientBusy(true);
    try {
      const opened = await openClientForm(null);
      setWonPrompt(false);
      if (!opened) setClientDone(true);
    } catch (err: any) {
      alert("Could not open the client form: " + (err?.message ?? String(err)));
    } finally { setClientBusy(false); }
  };
  // Opened from the board right after dropping the deal on Won: go straight to the client form.
  const autoClientDone = useRef(false);
  useEffect(() => {
    if (!startWithClient || autoClientDone.current) return;
    autoClientDone.current = true;
    clientNeeded().then((need) => { if (need) void createClientNow(); }).catch(() => {});
  }, [startWithClient]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const destinations = destinationsFor(picked, activePotentials);

    // Management keys clients by company. If no client exists yet for this
    // company, sales must create it (with legal info) BEFORE the handoff builds
    // a project. Open the prefilled form; the handoff fires once it's saved.
    // Management keys clients by company. If the client isn't set up yet (it
    // is normally created when the deal is won), the form opens first and the
    // handoff continues once it is saved.
    if (await openClientForm(destinations)) { setHandoffMenu(false); return; }

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
  const sendHandoff = async (destinations: { id: string; name: string; services: any[]; potential_value: number }[], pkg?: HandoffPackage) => {
    await createHandoffs({
      tracking_id: tracking.id,
      company_id: tracking.company_id,
      company_name: company?.name ?? null,
      product_id: tracking.product_id,
      destinations,
      package: pkg,
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
      {pendingHandover && (
        <HandoverConfirm
          deal={title}
          roleName={pendingHandover.plan.role.name} roleColor={pendingHandover.plan.role.color}
          fromNames={pendingHandover.plan.fromIds.map(empName)}
          toName={empName(pendingHandover.plan.toProfile)}
          lastPhase={pendingHandover.plan.lastPhase?.name ?? "—"} toPhase={pendingHandover.plan.toPhase.name}
          onConfirm={confirmHandover} onCancel={() => setPendingHandover(null)} />
      )}
      <header className="sl-head sl-d-head">
        <button className="sl-back" onClick={onBack} aria-label="Back">‹</button>
        <span className="sl-d-avatar">{title.slice(0, 1).toUpperCase()}</span>
        <div className="sl-d-id">
          {nameEdit !== null ? (
            <input className="sl-dn-input" autoFocus value={nameEdit} maxLength={120} aria-label="Deal name"
              placeholder={clientTitle}
              onChange={(e) => setNameEdit(e.target.value)}
              onBlur={() => void saveDealName()}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { e.stopPropagation(); setNameEdit(null); } }} />
          ) : (
            <h1 className="sl-title sl-dn-title" onClick={() => { setNameErr(null); setNameEdit(dealName.trim() || clientTitle); }} title="Rename this deal">
              {title}
              <span className="sl-dn-pen" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
              </span>
            </h1>
          )}
          {nameErr && <span className="sl-dn-err">{nameErr}</span>}
          <div className="sl-d-metaline">
            <span className={`sl-d-badge sl-badge-${status}`}>{statusText(status)}</span>
            <span className="sl-d-sub">
              {company ? (
                <span className="sl-d-co">
                  <button type="button" className="sl-d-colink" onClick={() => navigate("/companies", { state: { focusCompanyId: company.id } })} title="Open in Companies">{company.name}</button>
                  <LinksMenu links={companyQuickLinks(company, () => navigate("/companies", { state: { focusCompanyId: company.id } }))} label={`Links for ${company.name}`} />
                </span>
              ) : "Contact"}
              {tracking.contactIds.length > 0 && <> · {tracking.contactIds.map((cid, i) => (
                <span key={cid}>{i > 0 ? ", " : ""}<button type="button" className="sl-d-colink is-person" onClick={() => navigate("/contacts", { state: { focusContactId: cid } })} title="Open in Contacts">{contactName(cid)}</button></span>
              ))}</>}
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
                  onClick={() => applyStatus(s)} title={disabled ? "Define a win/loss phase in the pipeline first" : ""}>{statusText(s)}</button>
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
                      {employees.filter((e) => !inactive.has(e.id) || team.includes(e.id) || owner === e.id).map((e) => {
                        const on = team.includes(e.id);
                        const isOwner = owner === e.id;
                        const fit = on ? rolesFor(salesRoles, e.id, tracking.pipeline_id).fit : [];
                        return (
                          <div key={e.id} className={`sl-team-pop-item ${on ? "is-on" : ""}`}>
                          <div className={`sl-team-pop-row ${on ? "is-on" : ""} ${isOwner ? "is-owner" : ""}`}>
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
                          {fit.length > 0 && (
                            <div className="sl-team-pop-role">
                              <DealRolePicker roles={fit} personName={e.name} describe={describeDealRole}
                                value={resolveDealRole(salesRoles, e.id, tracking.pipeline_id, dealRoles[e.id])?.id ?? null}
                                disabled={!canAssign && e.id !== me?.id}
                                onChange={(rid) => pickDealRole(e.id, rid)} />
                            </div>
                          )}
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
                      <span className={`sl-flow-date ${state !== "future" ? "is-edit" : ""} ${dateEdit === p.id ? "is-on" : ""}`}
                        title={state !== "future" ? "Change the date" : undefined}
                        onClick={(ev) => { if (state === "future") return; ev.stopPropagation(); dateAnchor.current = ev.currentTarget; setDateEdit(p.id); }}>
                        {entered ? fmtDate(entered) : state !== "future" ? "+ date" : "—"}
                        {state !== "future" && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>}
                      </span>
                    </span>
                  </button>
                </div>
              );
            })}
            </div>
            {dateEdit && (
              <DatePicker hideTrigger open anchorRef={dateAnchor} value={(phaseEnteredAt(dateEdit) ?? "").slice(0, 10)}
                maxDate={new Date().toISOString().slice(0, 10)}
                onOpenChange={(o) => { if (!o) setDateEdit(null); }}
                onChange={(d) => { const id = dateEdit; setDateEdit(null); void changePhaseDate(id, d); }} />
            )}
          </div>
        </div>

        {/* Four columns */}
        <div className="sl-work">
          <div className={`sl-col-left${composing ? " has-composer" : ""}`}>
          <section className={`sl-panel sl-panel-compact sl-panel-notes${panelState("notes")}`} aria-hidden={composing && composing !== "notes" ? true : undefined}>
            <div className="sl-note-head">
              <h3 className="sl-panel-title">Notes{notes.length > 0 && <span>{notes.length}</span>}</h3>
              {composeCancel("notes") || notes.length > 0 && (
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

          <section className={`sl-panel sl-panel-compact sl-panel-notes${panelState("tasks")}`} aria-hidden={composing && composing !== "tasks" ? true : undefined}>
            <div className="sl-note-head">
              <h3 className="sl-panel-title sl-tasks-title">Tasks
                {/* Only counts that say something: no "0" and no "0 ✓" on an empty list. */}
                {tasks.some((t) => !t.done) && <span className="sl-tcount sl-tcount-todo" title="To do">{tasks.filter((t) => !t.done).length}</span>}
                {tasks.some((t) => t.done) && <span className="sl-tcount sl-tcount-done" title="Completed">{tasks.filter((t) => t.done).length} ✓</span>}
                {overdueCount > 0 && <span className="sl-tcount sl-tcount-late" title="Overdue">{overdueCount} late</span>}
                {urgentCount > 0 && <span className="sl-tcount sl-tcount-urgent" title="Urgent">{urgentCount} urgent</span>}
              </h3>
              {composeCancel("tasks") || tasks.length > 0 && (
                <button className="sl-see-icon" onClick={() => setItemsModal("tasks")} title={`See all ${tasks.length} tasks`} aria-label="See all tasks">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
                </button>
              )}
            </div>
            <div className="sl-task-add">
              <div className="sl-task-name-row">
                <MentionInput value={newTask} onChange={setNewTask} people={mentionPeople}
                  onMention={() => {}} placeholder="Task name... use @ to mention" />
                {!cleanMentions(newTask).trim() && <TemplatePicker templates={taskTemplates} kind="quick" onPick={pickTaskTemplate} compact />}
              </div>
              <div className={`sl-meet-reveal ${cleanMentions(newTask).trim() ? "is-writing" : ""}`}>
                <MentionInput multiline value={newTaskDesc} onChange={setNewTaskDesc} people={mentionPeople} className="sl-task-desc-input"
                  onMention={() => {}} placeholder="Description (optional) — the details, what done looks like…" />
                {taskFrom && (
                  <div className="hs-add-from">
                    <span>✦ From a template{taskFrom.checklist.length ? ` · ${taskFrom.checklist.length} steps` : ""}</span>
                    <button type="button" onClick={() => setTaskFrom(null)} aria-label="Don't use the template">×</button>
                  </div>
                )}
                <div className="sl-task-opts">
                  <div className="sl-task-prios" role="radiogroup" aria-label="Priority">
                    {TASK_PRIORITIES.map((p) => (
                      <button key={p} type="button" role="radio" aria-checked={taskPrio === p}
                        className={`hs-prio is-${p} ${taskPrio === p ? "is-on" : ""}`} onClick={() => setTaskPrio(p)}>
                        <FlagIcon /><span>{PRIORITY_LABEL[p]}</span>
                      </button>
                    ))}
                  </div>
                  <div className="sl-task-kind" role="radiogroup" aria-label="Kind of task">
                    {(["quick", "process"] as TaskKind[]).map((k) => (
                      <button key={k} type="button" role="radio" aria-checked={taskKind === k} className={taskKind === k ? "is-on" : ""}
                        onClick={() => setTaskKind(k)} title={k === "quick" ? "Tick it off and forget it" : "Longer work: status, % and progress notes"}>
                        {k === "quick" ? "Quick" : "Process"}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="sl-task-due">
                  <span className="sl-task-due-lbl">Due</span>
                  <DatePicker value={taskDue} onChange={setTaskDue} placeholder="Date" />
                  <TimePicker value={taskDueTime} onChange={setTaskDueTime} ariaLabel="Due time" />
                </div>
                <button className="sl-add-btn sl-meet-schedule" onClick={submitTask} disabled={!cleanMentions(newTask).trim() || !taskDue}>Add task</button>
              </div>
            </div>
          </section>

          <section className={`sl-panel sl-panel-compact sl-panel-notes${panelState("meetings")}`} aria-hidden={composing && composing !== "meetings" ? true : undefined}>
            <div className="sl-note-head">
              <h3 className="sl-panel-title">Meetings{meetings.length > 0 && <span>{meetings.length}</span>}</h3>
              {composeCancel("meetings") || meetings.length > 0 && (
                <button className="sl-see-icon" onClick={() => setItemsModal("meetings")} title={`See all ${meetings.length} meetings`} aria-label="See all meetings">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
                </button>
              )}
            </div>
            <div className="sl-meet-add">
              <MentionInput multiline value={meetTitle} onChange={setMeetTitle} people={mentionPeople}
                onMention={() => {}} placeholder="Meeting title... use @ to mention" />
              <div className={`sl-meet-reveal ${cleanMentions(meetTitle).trim() ? "is-writing" : ""}`}>
                <MeetingWhen date={meetDate} start={meetTime} end={meetEnd}
                  onDate={setMeetDate} onStart={setMeetTime} onEnd={setMeetEnd} />
                <div className="mf-kinds" role="radiogroup" aria-label="Type of meeting">
                  {MEETING_KINDS.map((k) => (
                    <button key={k.value} type="button" role="radio" aria-checked={meetKind === k.value}
                      className={meetKind === k.value ? "is-on" : ""} onClick={() => setMeetKind(k.value)}>
                      {k.icon}<span>{k.label}</span>
                    </button>
                  ))}
                </div>
                <button className="sl-add-btn sl-meet-schedule" onClick={submitMeeting} disabled={!cleanMentions(meetTitle).trim() || !meetDate || !spanOk(meetTime, meetEnd)}>Schedule</button>
              </div>
            </div>
            {meetSync && (
              <div className={`sl-ol-status is-${meetSync.state}`} role="status">
                <span className="sl-ol-ico">{OUTLOOK_ICON}</span>
                <span className="sl-ol-txt">
                  {meetSync.state === "syncing" ? "Adding to your Outlook…"
                    : meetSync.state === "ok" ? <>Added to your Outlook calendar
                        {meetSync.invited ? ` · ${meetSync.invited} ${meetSync.invited === 1 ? "person" : "people"} invited` : ""}
                        {meetSync.teams === "yes" ? " · Teams link created" : meetSync.teams === "skipped" ? " · no Teams link (not available on this account)" : ""}.</>
                    : meetSync.state === "gone" ? <><b>{meetSync.count && meetSync.count > 1 ? `${meetSync.count} meetings were` : "A meeting was"} deleted in Outlook</b> — removed here too.</>
                    : <><b>Not added to Outlook.</b> {meetSync.msg}</>}
                </span>
                {meetSync.state === "err" && <button className="sl-ol-retry" onClick={() => retryOutlook(meetSync.id)}>Try again</button>}
                {meetSync.state !== "syncing" && <button className="sl-ol-x" onClick={() => setMeetSync(null)} aria-label="Dismiss">×</button>}
              </div>
            )}
          </section>
          <DealPeople company={company} contacts={contacts} companyContactIds={companyContactIds}
            dealIds={Array.from(new Set([...trackingContactIds, ...tracking.contactIds]))}
            onChange={async (ids) => {
              setTrackingContactIds(ids); tracking.contactIds = ids;
              await setTrackingContacts(tracking.id, ids).catch(() => {});
            }} />
          </div>

          <div className="sl-col-right">
          <section className="sl-panel sl-panel-docs">
            <TrackingFiles trackingId={tracking.id} phaseId={curPhase} phases={phases} />
          </section>

          <FoldPanel className="sl-prob-panel" title="Close probability"
            summary={[
              `Sales ${repProb == null ? "—" : `${repProb}%`}`,
              `Mgmt ${mgrProb == null ? "—" : `${mgrProb}%`}`,
              closedOn && (status === "won" || status === "lost") ? `${status === "won" ? "Won" : "Lost"} ${new Date(`${closedOn}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : "",
            ].filter(Boolean).join(" · ")}>

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
                  <DatePicker value={repDate} placeholder="+ expected"
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
                    <DatePicker value={mgrDate} placeholder="+ expected"
                      onChange={(v) => { setMgrDate(v); setDealCloseDate(tracking.id, "mgr", v || null).catch(() => {}); }} />
                  ) : (
                    <span className="sl-probfield-date-ro">{mgrDate ? new Date(mgrDate).toLocaleDateString() : "—"}</span>
                  )}
                </span>
              </div>
            </div>
            <p className="sl-probfield-note">The dates above are the <b>expected</b> close dates.</p>

            <div className={`sl-probfield sl-closedon ${status === "won" ? "is-won" : status === "lost" ? "is-lost" : ""}`}>
              <span className="sl-probfield-k">
                Close date
                <em>{status === "won" ? "Won" : status === "lost" ? "Lost" : "Not closed yet"}</em>
              </span>
              <div className="sl-probfield-row">
                <span className="sl-closedon-txt">
                  {closedOn
                    ? `${status === "lost" ? "Lost" : status === "won" ? "Won" : "Closed"} on ${new Date(`${closedOn}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`
                    : status === "won" || status === "lost" ? "No date recorded" : "Filled in when the deal is won or lost"}
                </span>
                <span className="sl-probfield-datewrap">
                  <DatePicker value={closedOn} placeholder="+ date"
                    onChange={(v) => { setClosedOn(v); tracking.close_date = v || null; setDealClosedOn(tracking.id, v || null).catch(() => {}); }} />
                </span>
              </div>
            </div>
          </FoldPanel>

          {trackingFields.length > 0 && (
            <TrackingFieldsPanel trackingId={tracking.id} fields={trackingFields} initial={tracking.custom}
              onSaved={(c) => { tracking.custom = c; }} />
          )}
          </div>

          <div className="sl-col-calc">
          <DealProposals trackingId={tracking.id} groups={proposalGroups} decks={decks} money={money}
            busy={propBusyId} reloadKey={propsReload} onGenerate={generateProposalFor} onStudio={openStudio} onMain={applyMainLocally} />
          <section className="sl-panel sl-panel-calc">
            <div className="sl-rvh">
              <div className="sl-rvh-top">
                <h3 className="sl-panel-title">Potential revenue</h3>
                <b className="sl-rvh-total">{money(totalPotential)}</b>
              </div>
              <div className="sl-rvh-bar" aria-hidden="true">
                <i className="is-product" style={{ flexGrow: Math.max(0.0001, productsTotal) }} />
                <i className="is-service" style={{ flexGrow: Math.max(0.0001, servicesTotal) }} />
              </div>
              <div className="sl-rvh-legend">
                <span className="is-product"><i />Products<b>{money(productsTotal)}</b></span>
                <span className="is-service"><i />Services<b>{money(servicesTotal)}</b></span>
                {partnersTotal > 0 && <span className="is-partner" title="Already taken out of the figures above"><i />Partners<b>−{money(partnersTotal)}</b></span>}
              </div>
            </div>

            <div className="sl-rvg is-product">
              <div className="sl-rvg-head">
                <span className="sl-rvg-t"><i />Products<em>{activeTprods.length}</em></span>
                <b>{money(productsTotal)}</b>
              </div>
              {activeTprods.length === 0 && !leftOutGroups(tprods).length && <p className="sl-rvg-empty">No products yet.</p>}
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
                    onNewVersion={(copy) => newProdVersion(tp.id, copy)}
                    footer={<LineDocs key={tp.id} trackingId={tracking.id} lineId={tp.id} lineKind="product" phaseId={curPhase} versionLabel={`v${idx + 1}`} />} />
                );
              })}
              </div>
              {leftOutRows("product", tprods)}
              {availableProducts.length > 0 && (
                <div className="sl-rvg-add">
                  <Select value="" onChange={(v) => v && addProduct(v)} placeholder="+ Add product" options={availableProducts.map((p) => ({ value: p.id!, label: p.name }))} />
                </div>
              )}
            </div>

            <div className="sl-rvg is-service">
              <div className="sl-rvg-head">
                <span className="sl-rvg-t"><i />Services<em>{activePotentials.length}</em></span>
                <b>{money(servicesTotal)}</b>
              </div>
              {activePotentials.length === 0 && !leftOutGroups(potentials).length && <p className="sl-rvg-empty">No services yet.</p>}
              <div className="sl-calc-cards">
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
                    onNewVersion={(copy) => newSvcVersion(p.id, copy)}
                    footer={<LineDocs key={p.id} trackingId={tracking.id} lineId={p.id} lineKind="service" phaseId={curPhase} versionLabel={`v${idx + 1}`} />} />
                );
              })}
              </div>
              {leftOutRows("service", potentials)}
              {services.length > 0 && (
                <div className="sl-rvg-add">
                  <Select value="" onChange={(v) => v && addPotential(v)} placeholder="+ Add service" options={services.map((s) => ({ value: s.id!, label: s.name }))} />
                </div>
              )}
            </div>

            {revErr && <p className="sl-rev-err">Could not save: {revErr}</p>}
            <div className="sl-calc-foot sl-calc-foot-actions">
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
                {propMenu && <div className="sl-prop-scrim" onMouseDown={() => setPropMenu(false)} />}
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
              partnerItem={{ type: "product", id: tp.product_id }}
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
            roleName={(id) => roleNameOf(id, clientRoles)}
            calculator={svc?.calculator as Calculator | null}
            unit={svc?.rate_unit ?? "day"}
            minUnit={serviceMin(ps.service_id)}
            money={money}
            partnerItem={{ type: "service", id: ps.service_id }}
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
          signingDefault={wonDay()}
          standalone={!pendingHandoff}
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
          products={confirmProductCards()}
          extras={confirmExtras}
          money={money}
          onClose={() => { setConfirmOpen(false); setPendingHandoff(null); }}
          onConfirm={async ({ services, client, share, pkg, products: chosenProducts }) => {
            // The versions picked in the panel become the active ones on the deal.
            for (const sv of services) {
              const g = sv.group ?? sv.key;
              if (activeOfGroup(potentials, g)?.id !== sv.key) await switchSvcVersion(g, sv.key);
            }
            for (const pr of chosenProducts) {
              if (activeOfGroup(tprods, pr.group)?.id !== pr.key) await switchProdVersion(pr.group, pr.key);
            }
            // The client's contract gets the product version picked here, priced
            // from its calculator, with the breakdown to show on the client page.
            const signed = services.map((x) => x.signingDate).filter(Boolean).sort()[0] || null;
            const cidRow = tracking.company_id ? (await supabase.from("clients").select("id").eq("company_id", tracking.company_id).limit(1)).data?.[0] as any : null;
            if (cidRow?.id) {
              for (const pr of chosenProducts) {
                const l: any = pr.line;
                const bd = lineBreakdown(pr.line, pr.calculator, pr.catalogBase);
                const patch: Record<string, any> = {
                  price: Math.round(bd.unitPrice * 100) / 100, quantity: l.recurring ? 1 : bd.qty,
                  recurring: !!l.recurring, period: l.period ?? null, term_years: l.term_years ?? null,
                  discount_mode: "none", discount_value: 0,
                  breakdown: {
                    version: pr.versionLabel, multiplier: bd.multiplierLabel, gross: bd.gross, discount: bd.discount, total: bd.total,
                    rows: bd.rows.map((r) => ({ label: r.label, detail: r.detail, amount: r.amount, discount: r.discount })),
                  },
                };
                const write = async (body: Record<string, any>) => {
                  const up = await supabase.from("client_products").update(body)
                    .eq("client_id", cidRow.id).eq("tracking_id", tracking.id).eq("product_id", pr.productId).select("id");
                  if (up.error) return up.error;
                  if ((up.data ?? []).length) return null;
                  const ins = await supabase.from("client_products").insert({
                    ...body, client_id: cidRow.id, tracking_id: tracking.id, product_id: pr.productId,
                    signing_date: signed, start_date: signed, status: "active",
                  });
                  return ins.error;
                };
                let e = await write(patch);
                // Before handoff_v3.sql there is no breakdown column.
                if (e && /breakdown/i.test(e.message)) { const { breakdown: _b, ...rest } = patch; e = await write(rest); }
                if (e) console.warn("client product not updated:", e.message);
              }
            }
            // Client details, payment terms and documents are NOT written here: they
            // travel in the package and management applies them on "Build project"
            // (keep / fill blanks / update; documents are added, never replaced).
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

            const extras = confirmExtras;
            // What the client page shows from sales: excluded notes/tasks are hidden,
            // and the deal's documents now live in the client folders (or stay in sales).
            if (extras) {
              const offSet = new Set(share.off);
              const split = (items: { id: string }[], prefix: string, blockOn: boolean) => ({
                yes: items.filter((x) => blockOn && !offSet.has(`${prefix}:${x.id}`)).map((x) => x.id),
                no: items.filter((x) => !blockOn || offSet.has(`${prefix}:${x.id}`)).map((x) => x.id),
              });
              const n = split(extras.notes, "note", share.blocks.notes);
              const t = split(extras.tasks, "task", share.blocks.tasks);
              await Promise.all([
                n.yes.length && supabase.from("tracking_notes").update({ share_client: true }).in("id", n.yes),
                n.no.length && supabase.from("tracking_notes").update({ share_client: false }).in("id", n.no),
                t.yes.length && supabase.from("tracking_tasks").update({ share_client: true }).in("id", t.yes),
                t.no.length && supabase.from("tracking_tasks").update({ share_client: false }).in("id", t.no),
                // "Don't send" documents stay in sales; the rest are copied on Build project.
                (() => {
                  const hide = extras.docs.filter((d) => !destFolder(share.docDest[d.id] ?? "skip")).map((d) => d.id);
                  return hide.length && supabase.from("tracking_files").update({ share_client: false }).in("id", hide);
                })(),
              ].map((p) => Promise.resolve(p).catch(() => null)));
            }

            // Rebuild what goes to management from the calculator as edited in this
            // panel (the destinations were first priced before those edits).
            let toSend = pendingHandoff;
            if (pendingHandoff) {
              // Per line: the version picked in the panel, with the edits made there.
              const chosen = new Map(services.map((x) => [x.group ?? x.key, x]));
              const pots = activePotentials.map((p) => {
                const c = chosen.get(p.version_group ?? p.id);
                if (!c) return p;
                const row = potentials.find((q) => q.id === c.key) ?? p;
                return { ...row, ...(c.line as any), version_active: true } as PotentialService;
              });
              const picked = handoffTargets.filter((t) => pendingHandoff.some((d) => d.id === t.id));
              const chosenP = new Map(chosenProducts.map((x) => [x.group, x]));
              const prods = activeTprods.map((tp) => {
                const c = chosenP.get(tp.version_group ?? tp.id);
                return c ? ({ ...(tprods.find((q) => q.id === c.key) ?? tp), version_active: true } as TrackingProduct) : tp;
              });
              if (picked.length) toSend = destinationsFor(picked, pots, prods);
            }
            if (toSend) { await sendHandoff(toSend, pkg); setPendingHandoff(null); }
            setConfirmOpen(false);
          }}
        />
      )}

      {studio && decks && decks.length > 0 && (
        <ProposalStudio
          proposal={studio.proposal} decks={decks} data={studio.data}
          productIds={studio.productIds} serviceIds={studio.serviceIds} seller={seller}
          onClose={() => { setStudio(null); setPropsReload((n) => n + 1); }}
          onSaveDoc={(deckId, doc) => saveProposalDoc(studio.proposal.id, deckId, doc)}
          onGenerated={async (blob, fileName) => {
            const p = studio.proposal;
            // Kept on the deal: it goes with the handoff into the client's folders.
            const { file, error } = await uploadTrackingFile(tracking.id, curPhase, blob, fileName, `Proposal · ${p.name}`);
            if (error || !file) return error ?? "unknown error";
            const f = proposalFigures(p.lines, proposalGroups);
            const { error: e2 } = await saveDealProposal({ ...p, deck_id: undefined, file_id: file.id, gross: f.gross, partner: f.partner, total: f.total, is_main: undefined });
            return e2;
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
              return { key: `p:${vg}`, tag: "Product", name: productName((active ?? grp[0])?.product_id ?? null),
                versions: grp.map((v, i) => ({ id: v.id, label: `v${i + 1}`, amount: lineBreakdown(v, productOf(v.product_id)?.calculator as Calculator | null, productOf(v.product_id)?.tiers?.find((x: any) => x.id === v.tier_id)?.price).total })),
                activeId: active?.id ?? grp[grp.length - 1]?.id, leftOut: !active };
            }),
            ...Array.from(new Set(potentials.map((p) => p.version_group ?? p.id))).map((vg) => {
              const grp = groupOf(potentials, vg as string);
              const active = activeOfGroup(potentials, vg as string);
              return { key: `s:${vg}`, tag: "Service", name: ((active ?? grp[0])?.label || serviceName((active ?? grp[0])?.service_id ?? null)),
                versions: grp.map((v, i) => ({ id: v.id, label: `v${i + 1}`, amount: lineBreakdown(v, serviceOf(v.service_id)?.calculator as Calculator | null, undefined, serviceMin(v.service_id)).total })),
                activeId: active?.id ?? grp[grp.length - 1]?.id, leftOut: !active };
            }),
          ]}
          money={money}
          onClose={() => setPropPick(null)}
          onConfirm={(sel) => doGenerate(propPick, sel)}
        />
      )}

      {wonPrompt && (
        <HxPrompt icon="trophy" title="Deal won — create the client?"
          sub={<>Set up <b>{company?.name ?? "the client"}</b> now with its legal details, contacts and the products signed. Signing dates start on the day it was won. The handoff to management stays for later.</>}
          ghost="Later" primary="Create client" busy={clientBusy}
          onGhost={() => setWonPrompt(false)} onClose={() => setWonPrompt(false)} onPrimary={() => void createClientNow()} />
      )}
      {clientDone && (
        <HxPrompt icon="check" title="Client ready"
          sub={<><b>{company?.name ?? "The client"}</b> is set up. When the services are ready, send them to management with <b>Handoff</b>.</>}
          ghost={canHandoff ? "Close" : ""} primary={canHandoff ? "Open handoff" : "Done"}
          onGhost={() => setClientDone(false)} onClose={() => setClientDone(false)}
          onPrimary={() => { setClientDone(false); if (canHandoff) setHandoffMenu(true); }} />
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
          onFlipTask={flipTask} onEditTask={editTask} onDeleteTask={removeTask} onOpenTask={setOpenTaskId} canDeleteTask={canDelete}
          nameOf={empName}
          onEditMeeting={editMeeting} onKindMeeting={setMeetingKind} onDeleteMeeting={removeMeeting} onOutlookMeeting={retryOutlook}
          MiniAssignees={MiniAssignees} AssigneeArea={AssigneeArea}
        />
      )}

      {openTask && createPortal(
        <TaskPanel task={asMyTask(openTask)} onClose={() => setOpenTaskId(null)}
          onChange={(patch) => setTasks((xs) => xs.map((x) => (x.id === openTask.id ? { ...x, ...patch } : x)))}
          onDelete={canDelete(openTask) ? async () => {
            const id = openTask.id;
            const e = await deleteTask(id);
            if (e) { window.alert(e); return; }
            setOpenTaskId(null); setTasks((xs) => xs.filter((t) => t.id !== id));
          } : undefined}
          onExpand={() => { setTaskWindow(asMyTask(openTask)); setOpenTaskId(null); }} />,
        document.body,
      )}
      {taskWindow && (
        <TaskWorkspace initialId={taskWindow.id} extra={taskWindow}
          onClose={() => { setTaskWindow(null); void loadTasks(tracking.id).then(setTasks); }} />
      )}
    </div>
  );
}
// ============================ Note item (expand/collapse + inline edit) ============================
/**
 * While a note / task is being edited: put the cursor in its first field, and
 * let Escape cancel the edit (only — not close the list it's in).
 */
function useEditFocus(editing: boolean, cancel: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => {
    if (!editing) return;
    const el = ref.current?.querySelector<HTMLElement>("[contenteditable]");
    if (el) {
      el.focus();
      const sel = window.getSelection();
      if (sel) { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); }
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); cancelRef.current(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [editing]);
  return ref;
}

function NoteItem({ note, people, onEdit, onDelete, tagged, children, author, phase }: {
  people: MentionPerson[];
  note: TrackNote;
  onEdit: (id: string, body: string) => void | Promise<void>;
  onDelete: (id: string) => void;
  tagged?: React.ReactNode;
  children?: React.ReactNode;
  /** Who wrote it (notes from before the author was recorded have none). */
  author?: string | null;
  /** The deal phase it was written in. */
  phase?: string | null;
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
  const editRef = useEditFocus(editing, cancel);
  const when = note.created_at ? new Date(note.created_at) : null;
  const whenText = when ? when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
  const who = author || "Note";

  if (editing) {
    return (
      <div className="sl-edit-card" ref={editRef} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); } }}>
        <div className="sl-edit-card-head">
          <span className="sl-edit-card-ico" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
          </span>
          <b>Editing note</b>
          <small>Type @ to tag someone · Ctrl/⌘ + Enter to save</small>
        </div>
        <MentionInput multiline value={draft} onChange={setDraft} people={people} className="sl-edit-field" placeholder="Write the note…" />
        <div className="sl-edit-card-foot">
          <button className="sl-edit-cancel" onClick={cancel}>Cancel</button>
          <button className="sl-edit-save" onClick={save} disabled={!draft.trim()}>Save note</button>
        </div>
      </div>
    );
  }

  return (
    <article className="sl-note sl-note-card">
      <header className="sl-note-top">
        <span className={`sl-note-av ${author ? "" : "is-anon"}`} aria-hidden="true">{author ? author.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") : "✎"}</span>
        <div className="sl-note-by">
          <b>{who}</b>
          <small>{whenText}{phase ? <> · <span className="sl-note-phase">{phase}</span></> : null}</small>
        </div>
        <div className="sl-note-tools">
          {tagged}
          <button className="sl-note-edit-btn" onClick={() => { setDraft(note.body); setEditing(true); }} aria-label="Edit" title="Edit">✎</button>
          <button className="sl-note-x" onClick={() => onDelete(note.id)} aria-label="Delete" title="Delete">×</button>
        </div>
      </header>
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
    </article>
  );
}

// ============================ Task item (name, description, priority, stage) ============================
/**
 * One task: the tick, its name and description, and chips for priority,
 * stage (status + %) and when it's due. The row is tinted by priority and the
 * stage pill is solid, so both read at a glance. Click it to open the task
 * panel (status, %, progress notes); ✎ edits the name and description in place.
 */
function TaskItem({ task, people, overdue, onToggle, onEdit, onDelete, onOpen, tagged, canDelete = true }: {
  people: MentionPerson[];
  task: TrackTask;
  overdue?: boolean;
  onToggle: (t: TrackTask) => void;
  onEdit: (id: string, title: string, description?: string) => void | Promise<void>;
  onDelete: (id: string) => void;
  onOpen?: (id: string) => void;
  tagged?: React.ReactNode;
  /** Only whoever created the task can delete it. */
  canDelete?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const [draftDesc, setDraftDesc] = useState(task.description ?? "");
  const prio = task.priority ?? "normal";
  const status = task.status ?? (task.done ? "done" : "todo");
  const progress = task.progress ?? (task.done ? 100 : 0);
  const isProcess = task.kind === "process";

  const save = async () => {
    const v = draft.trim();
    if (!v) return;
    if (v !== task.title || draftDesc.trim() !== (task.description ?? "").trim()) await onEdit(task.id, v, draftDesc);
    setEditing(false);
  };
  const cancel = () => { setDraft(task.title); setDraftDesc(task.description ?? ""); setEditing(false); };
  const editRef = useEditFocus(editing, cancel);

  if (editing) {
    return (
      <div className={`sl-edit-card is-p-${prio}`} ref={editRef} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); } }}>
        <div className="sl-edit-card-head">
          <span className="sl-edit-card-ico" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
          </span>
          <b>Editing task</b>
          <small>Type @ to tag someone · Ctrl/⌘ + Enter to save</small>
        </div>
        <label className="sl-edit-lbl">Name</label>
        <MentionInput value={draft} onChange={setDraft} people={people} className="sl-edit-field is-title" placeholder="What needs doing" onEnter={save} />
        <label className="sl-edit-lbl">Description</label>
        <MentionInput multiline value={draftDesc} onChange={setDraftDesc} people={people} className="sl-edit-field" placeholder="The details, links, what done looks like… (optional)" />
        <div className="sl-edit-card-foot">
          {onOpen && <button className="sl-edit-more" onClick={() => { cancel(); onOpen(task.id); }}>Status, % and deadline →</button>}
          <button className="sl-edit-cancel" onClick={cancel}>Cancel</button>
          <button className="sl-edit-save" onClick={save} disabled={!draft.trim()}>Save task</button>
        </div>
      </div>
    );
  }

  const todayIso = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  return (
    <div className={`sl-task is-p-${prio} is-s-${status} ${task.done ? "is-done" : ""} ${overdue ? "is-overdue" : ""} ${onOpen ? "is-openable" : ""}`}
      style={{ ["--pct" as string]: `${progress}%` } as React.CSSProperties}
      onClick={() => onOpen?.(task.id)}>
      <button className="sl-check" onClick={(e) => { e.stopPropagation(); onToggle(task); }} aria-label={task.done ? "Mark as not done" : "Mark as done"}>{task.done && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
      )}</button>
      <div className="sl-task-body">
        <span className="sl-task-title">{cleanMentionsFn(task.title)}</span>
        {task.description?.trim() && <span className="sl-task-desc">{cleanMentionsFn(task.description)}</span>}
        <div className="sl-task-meta">
          {prio !== "normal" && <span className={`hs-prio is-${prio}`}><FlagIcon /><span>{PRIORITY_LABEL[prio]}</span></span>}
          {!task.done && (isProcess || status !== "todo") && (
            <span className={`hs-st is-${status}`}><i />{STATUS_LABEL[status]}{isProcess || progress > 0 ? ` · ${progress}%` : ""}</span>
          )}
          <DueChip dueAt={task.due_at} todayIso={todayIso} done={task.done} />
          {(task.checklist?.length ?? 0) > 0 && <span className="htw-item-steps">{task.checklist!.filter((x) => x.done).length}/{task.checklist!.length} steps</span>}
          <span onClick={(e) => e.stopPropagation()}>{tagged}</span>
        </div>
        {isProcess && !task.done && <span className="sl-task-bar" aria-label={`${progress}% done`}><i /></span>}
      </div>
      <button className="sl-note-edit-btn sl-inline-edit-btn" onClick={(e) => { e.stopPropagation(); setDraft(task.title); setDraftDesc(task.description ?? ""); setEditing(true); }} aria-label="Edit">✎</button>
      {canDelete && <button className="sl-task-x sl-inline-x" onClick={(e) => { e.stopPropagation(); onDelete(task.id); }} aria-label="Delete" title="Delete">×</button>}
    </div>
  );
}

// ============================ Meeting item (date/time left, title clamp+expand, edit) ============================
const OUTLOOK_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4.5" width="18" height="16" rx="3" /><path d="M3 9h18M8 2.5v4M16 2.5v4" /><path d="M8.5 14.5l2.2 2.2 4.8-4.8" />
  </svg>
);
/** Small Outlook chip on a meeting: in Outlook / not yet (click to add) / failed (click to retry). */
function OutlookChip({ meeting, onOutlook }: { meeting: TrackMeeting; onOutlook?: (id: string) => void }) {
  if (!meeting.mine) return null;
  if (meeting.outlook_syncing) return <span className="sl-ol-chip is-syncing" title="Adding to your Outlook…">{OUTLOOK_ICON}<i>…</i></span>;
  if (meeting.outlook_event_id && !meeting.outlook_error) return <span className="sl-ol-chip is-ok" title="In your Outlook calendar">{OUTLOOK_ICON}<i>Outlook</i></span>;
  return (
    <button className={`sl-ol-chip ${meeting.outlook_error ? "is-err" : "is-off"}`} onClick={() => onOutlook?.(meeting.id)}
      title={meeting.outlook_error ? `Not in Outlook: ${meeting.outlook_error} — click to try again` : "Not in your Outlook yet — click to add it"}>
      {OUTLOOK_ICON}<i>{meeting.outlook_error ? "Retry" : "Add"}</i>
    </button>
  );
}
/* ---- Meeting day, start and end ---- */
const toMin = (t: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t ?? ""); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
const fromMin = (n: number) => { const v = Math.max(0, Math.min(1439, n)); return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`; };
/** "HH:MM" moved by some minutes, kept inside the day. */
const shiftTime = (t: string, by: number) => (Number.isFinite(toMin(t)) ? fromMin(toMin(t) + by) : t);
/** A meeting must end after it starts (same day). */
const spanOk = (start: string, end: string) => Number.isFinite(toMin(start)) && Number.isFinite(toMin(end)) && toMin(end) > toMin(start);
const durLabel = (min: number) => (min < 60 ? `${min} min` : min % 60 ? `${Math.floor(min / 60)} h ${min % 60}` : `${min / 60} h`);

/**
 * Day, then "from → to" with the length worked out. Moving the start keeps the
 * length (a 1 h meeting stays 1 h); the end offers quick lengths from the start.
 */
function MeetingWhen({ date, start, end, onDate, onStart, onEnd }: {
  date: string; start: string; end: string;
  onDate: (v: string) => void; onStart: (v: string) => void; onEnd: (v: string) => void;
}) {
  const s = toMin(start), e = toMin(end);
  const ok = spanOk(start, end);
  const moveStart = (v: string) => {
    const len = ok ? e - s : 60;
    onStart(v);
    if (Number.isFinite(toMin(v))) onEnd(fromMin(toMin(v) + len));
  };
  const quick = Number.isFinite(s) ? [30, 45, 60, 90].map((m) => fromMin(s + m)).filter((t, i, a) => toMin(t) > s && a.indexOf(t) === i) : undefined;
  return (
    <div className="mf-when">
      <DatePicker value={date} onChange={onDate} placeholder="Date" />
      <div className={`mf-span ${ok ? "" : "is-bad"}`}>
        <TimePicker value={start} onChange={moveStart} ariaLabel="Starts" placeholder="Start" />
        <span className="mf-span-arrow" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        </span>
        <TimePicker value={end} onChange={onEnd} ariaLabel="Ends" placeholder="End" quick={quick} />
        <span className="mf-dur" role="status" title={ok ? "Length of the meeting" : "The end has to be after the start"}>
          {ok ? durLabel(e - s) : "Ends before it starts"}
        </span>
      </div>
    </div>
  );
}

function MeetingItem({ meeting, people, fmtMeet, onEdit, onDelete, onKind, onOutlook, tagged }: {
  onOutlook?: (id: string) => void;
  people: MentionPerson[];
  onKind: (id: string, kind: MeetingKind) => void;
  meeting: TrackMeeting;
  fmtMeet: (iso: string | null) => string;
  onEdit: (id: string, title: string, meetAt?: string | null, endAt?: string | null) => void | Promise<void>;
  onDelete: (id: string) => void;
  tagged?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(meeting.title);
  // day & time while editing
  const splitAt = (iso: string | null) => (iso ? [iso.slice(0, 10), iso.slice(11, 16)] : ["", "10:00"]);
  const [draftDate, setDraftDate] = useState(splitAt(meeting.meet_at)[0]);
  const [draftTime, setDraftTime] = useState(splitAt(meeting.meet_at)[1]);
  const endOf = (m: TrackMeeting) => (m.end_at ? m.end_at.slice(11, 16) : shiftTime(splitAt(m.meet_at)[1], 60));
  const [draftEnd, setDraftEnd] = useState(endOf(meeting));
  const startEdit = () => { setDraft(meeting.title); const [d, t] = splitAt(meeting.meet_at); setDraftDate(d); setDraftTime(t); setDraftEnd(endOf(meeting)); setEditing(true); };
  const [overflowing, setOverflowing] = useState(false);
  const pRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const el = pRef.current;
    if (el && !editing) setOverflowing(el.scrollHeight > el.clientHeight + 2);
  }, [meeting.title, editing, expanded]);

  const save = async () => {
    const v = draft.trim();
    if (!spanOk(draftTime, draftEnd)) return;
    const at = draftDate && draftTime ? `${draftDate}T${draftTime}:00` : null;
    const endAt = draftDate && draftEnd ? `${draftDate}T${draftEnd}:00` : null;
    if (v || at) await onEdit(meeting.id, v || meeting.title, at, endAt);
    setEditing(false);
  };
  const cancel = () => { setDraft(meeting.title); setEditing(false); };

  const when = meeting.meet_at ? new Date(meeting.meet_at) : null;
  const wd = when ? when.toLocaleDateString("en-GB", { weekday: "short" }) : "";
  const dayNum = when ? when.getDate() : "–";
  const mon = when ? when.toLocaleDateString("en-GB", { month: "short" }) : "";
  const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const ends = meeting.end_at ? new Date(meeting.end_at) : when ? new Date(when.getTime() + 60 * 60000) : null;
  const timeRange = when && ends ? `${hhmm(when)} – ${hhmm(ends)}` : "No time";
  void fmtMeet;

  const past = !!ends && ends.getTime() < Date.now();
  const kind = (meeting.kind ?? "in_person") as MeetingKind;
  const kindDef = MEETING_KINDS.find((k) => k.value === kind) ?? MEETING_KINDS[2];
  // the text with @mentions shown as names
  const parts = (meeting.title ?? "").split(/(@\[[^\]]+\]\([^)]+\))/g);

  return (
    <div className={`sl-mt ${past ? "is-past" : ""} ${editing ? "is-editing" : ""}`}>
      <button type="button" className="sl-mt-date" onClick={() => { if (!editing) startEdit(); }} title={editing ? undefined : "Change day or time"} disabled={editing}>
        <small>{wd}</small><b>{dayNum}</b><small>{mon}</small>
      </button>
      <div className="sl-mt-body">
        {editing ? (
          <div className="sl-mt-edit">
            <MentionInput multiline value={draft} onChange={setDraft} people={people} placeholder="What's the meeting about? Type @ to invite someone" />
            <MeetingWhen date={draftDate} start={draftTime} end={draftEnd}
              onDate={setDraftDate} onStart={setDraftTime} onEnd={setDraftEnd} />
            <div className="mf-kinds" role="radiogroup" aria-label="Type of meeting">
              {MEETING_KINDS.map((k) => (
                <button key={k.value} type="button" role="radio" aria-checked={kind === k.value}
                  className={kind === k.value ? "is-on" : ""} onClick={() => onKind(meeting.id, k.value)}>
                  {k.icon}<span>{k.label}</span>
                </button>
              ))}
            </div>
            <div className="sl-mt-edit-acts">
              <button className="sl-mt-btn" onClick={cancel}>Cancel</button>
              <button className="sl-mt-btn is-primary" onClick={save} disabled={!draft.trim() || !spanOk(draftTime, draftEnd)}>Save</button>
            </div>
          </div>
        ) : (
          <>
            <p ref={pRef}
              className={`sl-mt-title ${expanded ? "is-expanded" : "is-clamped"}`}
              onClick={() => (overflowing || expanded) && setExpanded((v) => !v)}
              style={{ cursor: (overflowing || expanded) ? "pointer" : "default" }}
            >
              {parts.map((t, i) => {
                const m = /^@\[([^\]]+)\]\([^)]+\)$/.exec(t);
                return m ? <b key={i} className="sl-mt-at">@{m[1]}</b> : <span key={i}>{t}</span>;
              })}
            </p>
            {(overflowing || expanded) && (
              <button className="sl-mt-more" onClick={() => setExpanded((v) => !v)}>{expanded ? "Show less" : "Show more"}</button>
            )}
            <div className="sl-mt-meta">
              <span className="sl-mt-chip">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7.5V12l3 2" /></svg>
                {timeRange}
              </span>
              <span className={`sl-mt-chip is-kind is-${kind}`}>{kindDef.icon}{kindDef.label}</span>
              <OutlookChip meeting={meeting} onOutlook={onOutlook} />
              {tagged}
              {past && <span className="sl-mt-chip is-done">Done</span>}
            </div>
          </>
        )}
      </div>
      {!editing && (
        <div className="sl-mt-acts">
          <button onClick={startEdit} aria-label="Edit" title="Edit text, day, time and type">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
          </button>
          <button className="is-danger" onClick={() => onDelete(meeting.id)} aria-label="Delete" title="Delete meeting">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
          </button>
        </div>
      )}
    </div>
  );
}
// ============================ Items modal (all notes / tasks / meetings) ============================
function ItemsModal({ kind, phases, onClose, notes, tasks, meetings, people, fmtMeet,
  onEditNote, onDeleteNote, onFlipTask, onEditTask, onDeleteTask, onOpenTask, canDeleteTask, nameOf,
  onEditMeeting, onKindMeeting, onDeleteMeeting, onOutlookMeeting, MiniAssignees, AssigneeArea }: any) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title = kind === "notes" ? "All notes" : kind === "tasks" ? "All tasks" : "All meetings";

  const [q, setQ] = useState("");
  const [sort, setSort] = useState("recent");
  const [fPhase, setFPhase] = useState("");
  const [fStatus, setFStatus] = useState("all"); // tasks: all | todo | in_progress | blocked | done | overdue | urgent
  const taskOverdue = (t: any) => !t.done && !!t.due_at && new Date(t.due_at).getTime() < Date.now();
  const phaseName = (id: string | null) => (phases ?? []).find((p: any) => p.id === id)?.name ?? "No phase";
  /** "Today", "Yesterday", or "Monday 12 October 2026". */
  const noteDay = (iso: string) => {
    const d = new Date(iso + "T00:00:00");
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const diff = Math.round((t.getTime() - d.getTime()) / 86400000);
    if (diff === 0) return "Today";
    if (diff === 1) return "Yesterday";
    return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", ...(d.getFullYear() !== t.getFullYear() ? { year: "numeric" } : {}) });
  };
  const norm = (s: string) => (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const clean = (s: string) => (s ?? "").replace(/@\[([^\]]+)\]\([^)]+\)/g, "@$1");
  const textOf = (it: any) => kind === "notes" ? it.body : kind === "tasks" ? `${it.title ?? ""} ${it.description ?? ""}` : it.title;
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
      if (fStatus === "urgent") return !it.done && (it.priority === "urgent" || it.priority === "high");
      if (fStatus === "in_progress" || fStatus === "blocked") return !it.done && it.status === fStatus;
      return true;
    })
    .sort((a, b) => {
      if (sort === "prio" && kind === "tasks") {
        const rank: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
        return (a.done === b.done ? 0 : a.done ? 1 : -1) || (rank[a.priority ?? "normal"] - rank[b.priority ?? "normal"])
          || String(a.due_at || "9999").localeCompare(String(b.due_at || "9999"));
      }
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
                ...(kind === "tasks" ? [{ value: "prio", label: "Priority" }, { value: "due", label: "Due date" }] : []),
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
              { v: "all", l: "All" }, { v: "todo", l: "Open" }, { v: "in_progress", l: "In progress" }, { v: "blocked", l: "Blocked" },
              { v: "urgent", l: "Urgent & high" }, { v: "done", l: "Done" }, { v: "overdue", l: "Overdue" },
            ].filter((s) => {
              // Only offer a stage / priority filter when some task is in it.
              if (s.v === "in_progress" || s.v === "blocked") return tasks.some((t: any) => !t.done && t.status === s.v);
              if (s.v === "urgent") return tasks.some((t: any) => !t.done && (t.priority === "urgent" || t.priority === "high"));
              return true;
            }).map((s) => (
              <button key={s.v} className={`sl-im-statusbtn is-${s.v} ${fStatus === s.v ? "is-on" : ""} ${s.v === "overdue" ? "is-late" : ""}`} onClick={() => setFStatus(s.v)}>
                {s.l}{s.v === "overdue" && tasks.filter(taskOverdue).length > 0 ? ` (${tasks.filter(taskOverdue).length})` : ""}
              </button>
            ))}
          </div>
        )}
        <div className="sl-im-body">
          {shown.length === 0 ? (
            <p className="sl-hint">{q ? `No ${kind} match your search.` : `No ${kind} yet.`}</p>
          ) : kind === "notes" ? (
            <div className="sl-notes sl-notes-timeline">
              {shown.map((n: any, i: number) => {
                // A date line whenever the day changes (in date order); none when sorted by name.
                const day = (n.created_at ?? "").slice(0, 10);
                const prevDay = i > 0 ? (shown[i - 1].created_at ?? "").slice(0, 10) : null;
                const showDay = sort !== "name" && day && day !== prevDay;
                return (
                  <div key={n.id} className="sl-nt-item">
                    {showDay && <div className="sl-nt-day"><span>{noteDay(day)}</span></div>}
                    <NoteItem note={n} people={people} onEdit={onEditNote} onDelete={onDeleteNote}
                      author={n.created_by && nameOf ? nameOf(n.created_by) : null}
                      phase={n.phase_id ? phaseName(n.phase_id) : null}
                      tagged={<MiniAssignees itemId={n.id} compact />}>
                      <AssigneeArea itemId={n.id} />
                    </NoteItem>
                  </div>
                );
              })}
            </div>
          ) : kind === "tasks" ? (
            <div className="sl-tasks">
              {shown.map((t: any) => (
                <TaskItem key={t.id} task={t} people={people} overdue={!t.done && !!t.due_at && new Date(t.due_at).getTime() < Date.now()} onToggle={onFlipTask} onEdit={onEditTask} onDelete={onDeleteTask} onOpen={onOpenTask}
                  canDelete={canDeleteTask ? canDeleteTask(t) : true} tagged={<MiniAssignees itemId={t.id} compact />} />
              ))}
            </div>
          ) : (
            <div className="sl-meetings">
              {shown.map((m: any) => (
                <MeetingItem key={m.id} meeting={m} people={people} fmtMeet={fmtMeet} onEdit={onEditMeeting} onKind={onKindMeeting} onDelete={onDeleteMeeting} onOutlook={onOutlookMeeting} tagged={<MiniAssignees itemId={m.id} compact />} />
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
  groups: { key: string; tag: string; name: string; versions: { id: string; label: string; amount: number }[]; activeId: string; leftOut?: boolean }[];
  money: (n: number) => string;
  onClose: () => void;
  onConfirm: (sel: Record<string, { include: boolean; versionId: string }>) => void;
}) {
  const [sel, setSel] = useState<Record<string, { include: boolean; versionId: string }>>(() => {
    const o: Record<string, { include: boolean; versionId: string }> = {};
    groups.forEach((g) => { o[g.key] = { include: !g.leftOut, versionId: g.activeId }; });
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