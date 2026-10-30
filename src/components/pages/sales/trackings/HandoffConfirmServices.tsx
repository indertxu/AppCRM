/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import DatePicker from "../../../framework/DatePicker";
import Select from "../../../framework/Select";
import LineCalcModal from "../../../framework/LineCalcModal";
import { lineBreakdown, type RevenueLineFields, type TermPatch } from "../sales/salesApi";
import type { Calculator } from "../../settings/catalogApi";
import { FileIcon, kindOf, prettySize, openTrackingFile } from "./TrackingFiles";
import { MentionText } from "../../../framework/MentionInput";
import "./HandoffConfirmServices.css";

export interface ConfirmContact { id: string; sourceId?: string | null; name: string; position: string; email: string; phone: string; billing: boolean; selected?: boolean; }
export interface ConfirmClient {
  legalName: string; vatNumber: string;
  address: { street: string; number: string; details: string; postalCode: string; city: string; country: string };
  contacts: ConfirmContact[];
}
export interface ConfirmService {
  key: string;
  serviceId: string;
  name: string;
  line: RevenueLineFields;
  calculator: Calculator | null;
  unit: "hour" | "day" | null;
  minUnit?: number;
  signingDate: string;          // per-service signing date
  contactIds?: string[];             // contacts on THIS service (several, independent)
  billingContactId?: string | null;  // exclusive billing contact for THIS service
  /** Version group of the line, its label ("v2"), and every version to pick from. */
  group?: string;
  versionLabel?: string;
  alts?: ConfirmService[];
}
/** A product sold on the deal: the version picked here is what the client's contract gets. */
export interface ConfirmProduct {
  key: string;
  group: string;
  productId: string;
  name: string;
  line: RevenueLineFields;
  calculator: Calculator | null;
  catalogBase?: number;
  versionLabel: string;
  alts: Omit<ConfirmProduct, "alts">[];
}

/* =====================================================================
   The handoff package: everything sales passes to management, by block.
   ===================================================================== */
export type BlockKey = "client" | "services" | "deal" | "revenue" | "revdocs" | "dealdocs" | "notes" | "tasks";
/** Where a document lands on the client: a contract slot, a directory folder, or nowhere. */
export type DocDest = string; // "license" | "service" | "proposal" | "folder:<name>" | "skip"

export interface HandoffDoc {
  id: string; name: string; mime: string | null; size: number | null; note?: string | null; created_at?: string;
  bucket: string; path: string;
  group: "revenue" | "deal";
  /** Service documents: the line and version they belong to. */
  lineLabel?: string; kind?: "product" | "service"; version?: string; active?: boolean;
  /** Filled in the package. */
  dest?: DocDest; destLabel?: string;
}
export interface HandoffNote { id: string; body: string; created_at: string; author?: string | null; phase?: string | null }
export interface HandoffTaskItem { id: string; title: string; description?: string | null; done: boolean; due_at?: string | null; status?: string | null; priority?: string | null; phase?: string | null }
export interface HandoffRevLine {
  key: string; label: string; kind: "product" | "service"; total: number; gross: number; discount: number;
  summary: string; version: string; rows: { label: string; detail?: string; amount: number; discount?: number }[];
}
export interface HandoffDealInfo { title: string; fields: { label: string; value: string }[] }
export interface HandoffExtras {
  deal: HandoffDealInfo; revenue: HandoffRevLine[]; docs: HandoffDoc[];
  notes: HandoffNote[]; tasks: HandoffTaskItem[];
  /** The client's own directory folders (root level), offered as destinations. */
  folders: string[];
}
export interface HandoffPkgService {
  name: string; total: number; gross?: number; discount?: number; qty?: string; signingDate?: string;
  contacts?: string[]; billTo?: string | null; rows?: { label: string; detail?: string; amount: number; discount?: number }[];
}
export interface HandoffPackage {
  v: 1; sent_at: string; company?: string | null;
  blocks: Partial<Record<BlockKey, boolean>>;
  client?: { mode: "use" | "update"; legalName: string; vatNumber: string; address: ConfirmClient["address"]; paymentDays: number | null };
  services?: HandoffPkgService[];
  deal?: HandoffDealInfo;
  revenue?: HandoffRevLine[];
  documents?: HandoffDoc[];
  notes?: HandoffNote[];
  tasks?: HandoffTaskItem[];
}
export interface HandoffShare {
  blocks: Record<BlockKey, boolean>;
  /** Items left out: "note:<id>", "task:<id>", "rev:<key>", "deal:<label>". */
  off: string[];
  /** Destination per document id. */
  docDest: Record<string, DocDest>;
}

const SLOT_LABEL: Record<string, string> = { license: "License contracts", service: "Service contracts", proposal: "Proposals" };
/** Folder on the client that a destination maps to (null = not sent). */
export const destFolder = (d: DocDest): string | null =>
  d === "skip" ? null : SLOT_LABEL[d] ?? (d.startsWith("folder:") ? d.slice(7) : null);
export const destLabel = (d: DocDest): string =>
  d === "skip" ? "Not sent" : SLOT_LABEL[d] ? `Contracts · ${SLOT_LABEL[d]}` : d.startsWith("folder:") ? `Directory · ${d.slice(7)}` : d;
/** The client folder that gathers everything a handoff brings from sales. */
export const HANDOFF_FOLDER = "Handoff";
/** First guess: everything from sales together in the client's Handoff folder (a contract slot can still be picked). */
export const defaultDest = (_d: HandoffDoc): DocDest => `folder:${HANDOFF_FOLDER}`;

export const destOptions = (folders: string[]) => {
  const own = folders.filter((f) => !Object.values(SLOT_LABEL).some((s) => s.toLowerCase() === f.toLowerCase()));
  return [
    { value: `folder:${HANDOFF_FOLDER}`, label: HANDOFF_FOLDER, hint: "Everything from sales together" },
    { value: "license", label: "License contracts", hint: "Contract slot" },
    { value: "service", label: "Service contracts", hint: "Contract slot" },
    { value: "proposal", label: "Proposals", hint: "Contract slot" },
    ...own.filter((f) => f.toLowerCase() !== HANDOFF_FOLDER.toLowerCase()).map((f) => ({ value: `folder:${f}`, label: f, hint: "Directory folder" })),
    ...(own.some((f) => f.toLowerCase() === "sales documents") ? [] : [{ value: "folder:Sales documents", label: "Sales documents", hint: "New directory folder" }]),
    { value: "skip", label: "Don't send", hint: "Stays in sales" },
  ];
};

const BLOCKS: { key: BlockKey; title: string; sub: string; icon: string }[] = [
  { key: "client", title: "Client details", sub: "Legal name, tax ID, address and payment terms", icon: "M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6M9 10h.01M15 10h.01" },
  { key: "services", title: "Services & contract", sub: "What management builds the project from", icon: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z" },
  { key: "deal", title: "Deal details", sub: "Owner, team, dates and custom fields", icon: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" },
  { key: "revenue", title: "Potential revenue", sub: "The calculator lines as sold, with their version", icon: "M4 19V9M10 19V5M16 19v-7M22 19H2" },
  { key: "revdocs", title: "Service documents", sub: "Contract proposals attached to each version", icon: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5" },
  { key: "dealdocs", title: "Deal documents", sub: "Everything else filed on the deal", icon: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" },
  { key: "notes", title: "Notes", sub: "What the team wrote along the way", icon: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" },
  { key: "tasks", title: "Tasks", sub: "Open and finished to-dos on the deal", icon: "M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" },
];

const fmtDay = (iso?: string | null) => iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
const addrText = (a?: ConfirmClient["address"]) => a ? [[a.street, a.number].filter(Boolean).join(" "), a.details, [a.postalCode, a.city].filter(Boolean).join(" "), a.country].filter((x) => (x ?? "").trim()).join(", ") : "";

function Ico({ d, w = 1.9 }: { d: string; w?: number }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
}
function Switch({ on, onClick, disabled, label }: { on: boolean; onClick?: () => void; disabled?: boolean; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled}
      className={`hx2-switch ${on ? "is-on" : ""}`} onClick={(e) => { e.stopPropagation(); onClick?.(); }}>
      <i />
    </button>
  );
}
function Check({ on, onClick, disabled, label }: { on: boolean; onClick: () => void; disabled?: boolean; label: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} aria-label={label} disabled={disabled}
      className={`hx2-check ${on ? "is-on" : ""}`} onClick={onClick}>
      <Ico d="M20 6L9 17l-5-5" w={3} />
    </button>
  );
}

// Inline fallbacks so the panel is always usable even if its stylesheet fails to load.
const BACKDROP: CSSProperties = { position: "fixed", inset: 0, zIndex: 260, display: "grid", placeItems: "center", padding: "3vh", background: "rgba(6, 18, 13, 0.5)" };

const PROMPT_ICONS: Record<string, string> = {
  check: "M20 6L9 17l-5-5",
  trophy: "M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4",
  send: "M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z",
};
/**
 * A small centred question in the handoff style: "deal won, create the client
 * now?" and "send this to management?" both use it.
 */
export function HxPrompt({ icon = "check", title, sub, ghost, primary, onGhost, onPrimary, onClose, busy = false }: {
  icon?: "check" | "trophy" | "send"; title: string; sub: ReactNode; ghost: string; primary: string;
  onGhost: () => void; onPrimary: () => void; onClose: () => void; busy?: boolean;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [onClose]);
  return createPortal(
    <div className="hx-backdrop" style={{ ...BACKDROP, zIndex: 320 }} onMouseDown={onClose}>
      <div className="hx-prompt" onMouseDown={(e) => e.stopPropagation()} role="alertdialog" aria-modal="true" aria-label={title}>
        <span className="hx-prompt-glow" aria-hidden="true" />
        <div className="hx-prompt-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={PROMPT_ICONS[icon]} /></svg>
        </div>
        <h2 className="hx-prompt-title">{title}</h2>
        <p className="hx-prompt-sub">{sub}</p>
        <div className="hx-prompt-actions">
          {ghost && <button className="hx-btn-ghost" onClick={onGhost} disabled={busy}>{ghost}</button>}
          <button className="hx-btn-primary" onClick={onPrimary} disabled={busy} autoFocus>{busy ? "Working…" : primary}</button>
        </div>
        <button className="hx-prompt-x" onClick={onClose} aria-label="Close">×</button>
      </div>
    </div>,
    document.body);
}
const PANEL: CSSProperties = { width: "min(1360px, 96vw)", height: "92vh", display: "flex", flexDirection: "column", background: "#f2f5f3", borderRadius: 26, overflow: "hidden" };

interface ShellSection { key: BlockKey; on: boolean; locked?: boolean; count?: string; toggle?: () => void; tools?: ReactNode; body: ReactNode }

/** The big two-column panel: section nav on the left, the blocks on the right. Shared by the editor and the read-only view. */
function HxShell({ eyebrow, title, route, total, totalLabel, action, sections, readOnly, onClose }: {
  eyebrow: string; title: string; route?: ReactNode; total?: string; totalLabel?: string; action?: ReactNode;
  sections: ShellSection[]; readOnly?: boolean; onClose: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const secRefs = useRef<Partial<Record<BlockKey, HTMLElement | null>>>({});
  const [active, setActive] = useState<BlockKey>(sections[0]?.key ?? "client");
  const onScroll = () => {
    const b = bodyRef.current; if (!b) return;
    const top = b.getBoundingClientRect().top + 90;
    let cur = sections[0]?.key;
    for (const s of sections) { const el = secRefs.current[s.key]; if (el && el.getBoundingClientRect().top <= top) cur = s.key; }
    if (b.scrollTop + b.clientHeight >= b.scrollHeight - 4) cur = sections[sections.length - 1]?.key;
    if (cur) setActive(cur);
  };
  const go = (k: BlockKey) => { setActive(k); secRefs.current[k]?.scrollIntoView({ behavior: "smooth", block: "start" }); };
  // Esc closes the read-only view only: in the editor it would throw away the selection.
  useEffect(() => {
    if (!readOnly) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector(".sel-layer")) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, readOnly]);
  const onCount = sections.filter((s) => s.on).length;

  return (
    <div className="hx-backdrop hx2-backdrop" style={BACKDROP} onMouseDown={readOnly ? onClose : undefined}>
      <div className={`hx hx2 ${readOnly ? "is-readonly" : ""}`} style={PANEL} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <header className="hx-head hx2-head">
          <span className="hx-head-glow" aria-hidden="true" />
          <div className="hx-head-txt">
            <span className="hx-eyebrow">{eyebrow}</span>
            <h2 className="hx-title">{title}</h2>
            {route && <div className="hx2-route">{route}</div>}
          </div>
          <div className="hx-head-right">
            {!readOnly && <span className="hx2-headcount"><b>{onCount}</b> of {sections.length} blocks going</span>}
            {total != null && (
              <div className="hx-head-total hx2-total" title={totalLabel ?? "Services value"} aria-label={`${totalLabel ?? "Services value"}: ${total}`}>
                <i aria-hidden="true"><Ico d="M17 6.5A6.5 6.5 0 1 0 17 17.5M4 10.5h9M4 13.5h9" w={2.2} /></i>
                <b>{total}</b>
              </div>
            )}
            {action}
            <button className="hx-x" onClick={onClose} aria-label="Close">×</button>
          </div>
        </header>

        <div className="hx2-main">
          <nav className="hx2-nav" aria-label="Handoff blocks">
            {sections.map((s) => {
              const meta = BLOCKS.find((b) => b.key === s.key)!;
              return (
                <div key={s.key} className={`hx2-nav-i ${active === s.key ? "is-active" : ""} ${s.on ? "" : "is-off"}`}>
                  <button type="button" className="hx2-nav-go" onClick={() => go(s.key)}>
                    <span className="hx2-nav-ico"><Ico d={meta.icon} /></span>
                    <span className="hx2-nav-t">{meta.title}{s.count && <em>{s.count}</em>}</span>
                  </button>
                  {!readOnly && <Switch on={s.on} onClick={s.toggle} disabled={s.locked} label={`Send ${meta.title}`} />}
                </div>
              );
            })}
            {!readOnly && <p className="hx2-nav-note">Everything is on by default. Switch a block off, or untick single items, to keep them in sales.</p>}
          </nav>

          <div className="hx2-body" ref={bodyRef} onScroll={onScroll}>
            {sections.map((s, i) => {
              const meta = BLOCKS.find((b) => b.key === s.key)!;
              return (
                <section key={s.key} ref={(el) => { secRefs.current[s.key] = el; }} className={`hx2-sec ${s.on ? "" : "is-off"}`} style={{ ["--i" as any]: i }}>
                  <header className="hx2-sec-h">
                    <span className="hx2-sec-ico"><Ico d={meta.icon} /></span>
                    <div className="hx2-sec-t">
                      <h3>{meta.title}{s.count && <em>{s.count}</em>}</h3>
                      <p>{s.locked ? "Always sent — management builds the project from it" : meta.sub}</p>
                    </div>
                    <div className="hx2-sec-tools">
                      {s.on && s.tools}
                      {!readOnly && <Switch on={s.on} onClick={s.toggle} disabled={s.locked} label={`Send ${meta.title}`} />}
                    </div>
                  </header>
                  <div className="hx2-sec-b">
                    {!s.on && !readOnly && <div className="hx2-off-veil">Not sent — stays in sales</div>}
                    {s.body}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- read-only renderers, shared by both views ---------- */
function DealView({ deal, off, toggle, disabled }: { deal: HandoffDealInfo; off?: Set<string>; toggle?: (k: string) => void; disabled?: boolean }) {
  if (!deal.fields.length) return <p className="hx2-empty">No deal details.</p>;
  return (
    <div className="hx2-fields">
      {deal.fields.map((f) => {
        const k = `deal:${f.label}`;
        const on = !off?.has(k);
        return (
          <div key={f.label} className={`hx2-field ${on ? "" : "is-out"}`}>
            {toggle && <Check on={on} onClick={() => toggle(k)} disabled={disabled} label={`Send ${f.label}`} />}
            <span className="hx2-field-l">{f.label}</span>
            <span className="hx2-field-v">{f.value || "—"}</span>
          </div>
        );
      })}
    </div>
  );
}
function RevenueView({ lines, money, off, toggle, disabled }: { lines: HandoffRevLine[]; money: (n: number) => string; off?: Set<string>; toggle?: (k: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!lines.length) return <p className="hx2-empty">No revenue lines on this deal.</p>;
  return (
    <div className="hx2-rev">
      {lines.map((l) => {
        const k = `rev:${l.key}`;
        const on = !off?.has(k);
        return (
          <div key={l.key} className={`hx2-revline is-${l.kind} ${on ? "" : "is-out"}`}>
            <div className="hx2-revline-top">
              {toggle && <Check on={on} onClick={() => toggle(k)} disabled={disabled} label={`Send ${l.label}`} />}
              <span className={`hx2-kind is-${l.kind}`}>{l.kind === "product" ? "Product" : "Service"}</span>
              <span className="hx2-revline-name">{l.label}</span>
              {l.version && <span className="hx2-ver">{l.version}</span>}
              <span className="hx2-revline-sum">{l.summary}</span>
              <b className="hx2-revline-total">
                {l.discount > 0 && <s>{money(l.gross)}</s>}
                {money(l.total)}
              </b>
              {l.rows.length > 0 && (
                <button type="button" className={`hx2-mini ${open === l.key ? "is-on" : ""}`} onClick={() => setOpen(open === l.key ? null : l.key)} aria-label="Breakdown">
                  <Ico d={open === l.key ? "M18 15l-6-6-6 6" : "M6 9l6 6 6-6"} w={2.2} />
                </button>
              )}
            </div>
            {open === l.key && (
              <div className="hx2-revrows">
                {l.rows.map((r, i) => (
                  <div key={i}><span>{r.label}{r.detail ? <em> {r.detail}</em> : null}</span><b>{money(r.amount)}{r.discount ? <i> −{money(r.discount)}</i> : null}</b></div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
function DocRow({ d, right, out }: { d: HandoffDoc; right: ReactNode; out?: boolean }) {
  return (
    <div className={`hx2-doc ${out ? "is-out" : ""}`}>
      <FileIcon kind={kindOf(d.name, d.mime)} />
      <div className="hx2-doc-main">
        <button type="button" className="hx2-doc-name" onClick={() => openTrackingFile(d.path, d.bucket)} title={`Open ${d.name}`}>{d.name}</button>
        <span className="hx2-doc-meta">
          {d.version && <span className={`hx2-ver ${d.active ? "is-live" : ""}`}>{d.version}{d.active ? " · live" : ""}</span>}
          {prettySize(d.size)}{d.created_at ? ` · ${fmtDay(d.created_at)}` : ""}
        </span>
      </div>
      <div className="hx2-doc-right">{right}</div>
    </div>
  );
}
/** Service documents grouped by the line they belong to. */
function groupDocs(docs: HandoffDoc[]) {
  const m = new Map<string, HandoffDoc[]>();
  docs.forEach((d) => { const k = d.lineLabel ?? ""; m.set(k, [...(m.get(k) ?? []), d]); });
  return Array.from(m.entries());
}
function NotesView({ notes, off, toggle, disabled }: { notes: HandoffNote[]; off?: Set<string>; toggle?: (k: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (!notes.length) return <p className="hx2-empty">No notes on this deal.</p>;
  return (
    <div className="hx2-notes">
      {notes.map((n) => {
        const k = `note:${n.id}`;
        const on = !off?.has(k);
        const long = n.body.length > 220;
        const isOpen = open.has(n.id);
        return (
          <div key={n.id} className={`hx2-note ${on ? "" : "is-out"}`}>
            {toggle && <Check on={on} onClick={() => toggle(k)} disabled={disabled} label="Send this note" />}
            <div className="hx2-note-main">
              <span className="hx2-note-meta"><b>{n.author || "Someone"}</b>{fmtDay(n.created_at)}{n.phase ? <em>{n.phase}</em> : null}</span>
              <p className={`hx2-note-body ${long && !isOpen ? "is-clamped" : ""}`}><MentionText text={n.body} /></p>
              {long && <button type="button" className="hx2-link" onClick={() => setOpen((s) => { const x = new Set(s); if (x.has(n.id)) x.delete(n.id); else x.add(n.id); return x; })}>{isOpen ? "Show less" : "Show more"}</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
function TasksView({ tasks, off, toggle, disabled }: { tasks: HandoffTaskItem[]; off?: Set<string>; toggle?: (k: string) => void; disabled?: boolean }) {
  if (!tasks.length) return <p className="hx2-empty">No tasks on this deal.</p>;
  return (
    <div className="hx2-tasks">
      {tasks.map((t) => {
        const k = `task:${t.id}`;
        const on = !off?.has(k);
        return (
          <div key={t.id} className={`hx2-task ${on ? "" : "is-out"} ${t.done ? "is-done" : ""}`}>
            {toggle && <Check on={on} onClick={() => toggle(k)} disabled={disabled} label="Send this task" />}
            <span className={`hx2-task-dot ${t.done ? "is-done" : ""}`} aria-hidden="true" />
            <div className="hx2-task-main">
              <span className="hx2-task-t">{t.title ? <MentionText text={t.title} /> : "Untitled task"}</span>
              {t.description && <span className="hx2-task-d"><MentionText text={t.description} /></span>}
            </div>
            <span className="hx2-task-tags">
              {t.phase && <em>{t.phase}</em>}
              {t.due_at && <em>Due {fmtDay(t.due_at)}</em>}
              <em className={t.done ? "is-done" : "is-open"}>{t.done ? "Done" : (t.status ? t.status.replace(/_/g, " ") : "Open")}</em>
            </span>
          </div>
        );
      })}
    </div>
  );
}
function ClientView({ c }: { c: NonNullable<HandoffPackage["client"]> }) {
  const rows: [string, string][] = [
    ["Legal name", c.legalName], ["VAT / Tax ID", c.vatNumber], ["Address", addrText(c.address)],
    ["Payment terms", c.paymentDays != null ? `${c.paymentDays} days net` : ""],
    ["Details", c.mode === "update" ? "Updated from this deal" : "Kept as they were"],
  ];
  return <div className="hx2-fields">{rows.map(([l, v]) => <div key={l} className="hx2-field"><span className="hx2-field-l">{l}</span><span className="hx2-field-v">{v || "—"}</span></div>)}</div>;
}
function ServicesView({ services, money }: { services: HandoffPkgService[]; money: (n: number) => string }) {
  if (!services.length) return <p className="hx2-empty">No services in this handoff.</p>;
  return (
    <div className="hx-cards">
      {services.map((s, i) => (
        <div className="hx-card" key={i}>
          <span className="hx-card-accent" aria-hidden="true" />
          <div className="hx-card-top"><span className="hx-card-name">{s.name}</span></div>
          {(s.rows?.length ?? 0) > 0 && (
            <div className="hx-card-rows">
              {s.rows!.map((r, j) => (
                <div className="hx-crow" key={j}>
                  <span className="hx-crow-l">{r.label}{r.detail ? <em> {r.detail}</em> : null}</span>
                  <span className="hx-crow-r">{money(r.amount)}{r.discount ? <i>−{money(r.discount)}</i> : null}</span>
                </div>
              ))}
            </div>
          )}
          <div className="hx-card-foot">
            <span className="hx-card-qty">{s.qty ?? ""}</span>
            <span className="hx-card-total">{(s.discount ?? 0) > 0 && s.gross ? <em className="hx-card-gross">{money(s.gross)}</em> : null}<b>{money(s.total)}</b></span>
          </div>
          <div className="hx2-svc-facts">
            {s.signingDate && <span><i>Signed</i>{fmtDay(s.signingDate)}</span>}
            {(s.contacts?.length ?? 0) > 0 && <span><i>Contacts</i>{s.contacts!.join(", ")}</span>}
            {s.billTo && <span><i>Bill to</i>{s.billTo}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Read-only view of what sales handed over, in the same blocks the salesperson
 * saw. Used by Management → Incoming. Old handoffs without a package fall back
 * to their service lines.
 */
export function HandoffInfo({ pkg, fallbackServices = [], title, route, money, onClose }: {
  pkg: HandoffPackage | null | undefined; fallbackServices?: HandoffPkgService[]; title: string; route?: ReactNode;
  money: (n: number) => string; onClose: () => void;
}) {
  const p: HandoffPackage = pkg && pkg.v ? pkg : { v: 1, sent_at: "", blocks: { services: true } };
  const services = p.services?.length ? p.services : fallbackServices;
  const docs = p.documents ?? [];
  const rev = docs.filter((d) => d.group === "revenue");
  const deal = docs.filter((d) => d.group === "deal");
  const docRight = (d: HandoffDoc) => <span className={`hx2-dest ${d.dest === "skip" ? "is-skip" : ""}`}>{d.destLabel ?? destLabel(d.dest ?? "skip")}</span>;
  const empty = (txt: string) => <p className="hx2-empty">{txt}</p>;
  const noPkg = !pkg || !pkg.v;
  const sections: ShellSection[] = [
    { key: "client", on: !!p.client, body: p.client ? <ClientView c={p.client} /> : empty(noPkg ? "Sent before handoff packages existed." : "Sales kept the client details out of this handoff.") },
    { key: "services", on: true, count: String(services.length), body: <ServicesView services={services} money={money} /> },
    { key: "deal", on: !!p.deal, body: p.deal ? <DealView deal={p.deal} /> : empty("Not included.") },
    { key: "revenue", on: !!p.revenue, count: p.revenue ? String(p.revenue.length) : undefined, body: p.revenue ? <RevenueView lines={p.revenue} money={money} /> : empty("Not included.") },
    { key: "revdocs", on: rev.length > 0, count: rev.length ? String(rev.length) : undefined, body: rev.length ? groupDocs(rev).map(([g, ds]) => (
      <div className="hx2-docgroup" key={g}><span className="hx2-docgroup-t">{g || "Revenue line"}</span>{ds.map((d) => <DocRow key={d.id} d={d} right={docRight(d)} />)}</div>
    )) : empty("No service documents.") },
    { key: "dealdocs", on: deal.length > 0, count: deal.length ? String(deal.length) : undefined, body: deal.length ? deal.map((d) => <DocRow key={d.id} d={d} right={docRight(d)} />) : empty("No deal documents.") },
    { key: "notes", on: !!p.notes?.length, count: p.notes?.length ? String(p.notes.length) : undefined, body: p.notes?.length ? <NotesView notes={p.notes} /> : empty("No notes included.") },
    { key: "tasks", on: !!p.tasks?.length, count: p.tasks?.length ? String(p.tasks.length) : undefined, body: p.tasks?.length ? <TasksView tasks={p.tasks} /> : empty("No tasks included.") },
  ];
  const total = services.reduce((s, x) => s + (Number(x.total) || 0), 0);
  return createPortal(
    <HxShell readOnly eyebrow={p.sent_at ? `Handed over ${fmtDay(p.sent_at)}` : "Handoff from sales"} title={title} route={route}
      total={money(total)} sections={sections} onClose={onClose} />,
    document.body);
}

interface Props {
  clientName: string;
  skipPrompt?: boolean;   // client was just created → go straight to services
  client: ConfirmClient;
  services: ConfirmService[];
  /** The deal's products, each with its versions to pick from. */
  products?: ConfirmProduct[];
  /** Everything else on the deal (loaded after the panel opens). */
  extras?: HandoffExtras | null;
  money: (n: number) => string;
  onClose: () => void;
  onConfirm: (data: {
    services: ConfirmService[]; mode: "use" | "update";
    client: ConfirmClient; paymentDays: number | null;
    share: HandoffShare; pkg: HandoffPackage; products: ConfirmProduct[];
  }) => Promise<void> | void;
}

const uid = () => (globalThis.crypto?.randomUUID?.() ?? String(Math.random()));
const ALL_ON: Record<BlockKey, boolean> = { client: true, services: true, deal: true, revenue: true, revdocs: true, dealdocs: true, notes: true, tasks: true };

export default function HandoffConfirmServices({ clientName, skipPrompt = false, client: initialClient, services: initial, products: initialProducts = [], extras, money, onClose, onConfirm }: Props) {
  const [products, setProducts] = useState<ConfirmProduct[]>(initialProducts);
  /** The signing date for the whole handoff (each service can still differ). */
  const [signAll, setSignAll] = useState<string>(() => {
    const ds = Array.from(new Set(initial.map((s) => s.signingDate).filter(Boolean)));
    return ds.length === 1 ? ds[0] : "";
  });
  const [mode, setMode] = useState<"use" | "update" | null>(skipPrompt ? "use" : null);
  const [services, setServices] = useState<ConfirmService[]>(initial.map((s) => ({ ...s, contactIds: s.contactIds ?? [] })));
  // client.contacts is the ROSTER (company people + any newly added). Contacts
  // are assigned per service, not project-wide.
  const [client, setClient] = useState<ConfirmClient>(initialClient);
  const [paymentDays, setPaymentDays] = useState<number | null>(30);
  const [calcFor, setCalcFor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** "Send to management?" — the last check before anything leaves sales. */
  const [askSend, setAskSend] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<Record<BlockKey, boolean>>(ALL_ON);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [docDest, setDocDest] = useState<Record<string, DocDest>>({});
  // Fill each document's default destination once the deal's documents arrive.
  useEffect(() => {
    if (!extras) return;
    setDocDest((m) => { const x = { ...m }; extras.docs.forEach((d) => { if (!x[d.id]) x[d.id] = defaultDest(d); }); return x; });
  }, [extras]);

  const bdOf = (s: ConfirmService) => lineBreakdown(s.line, s.calculator, undefined, s.minUnit);
  const total = useMemo(() => services.reduce((sum, s) => sum + bdOf(s).total, 0), [services]);

  const setService = (key: string, patch: Partial<ConfirmService>) => setServices((ss) => ss.map((s) => s.key === key ? { ...s, ...patch } : s));
  const applyCalc = (key: string, patch: TermPatch) => { setService(key, { line: { ...(services.find((s) => s.key === key)!.line), ...(patch as any) } }); setCalcFor(null); };

  const setAddr = (k: keyof ConfirmClient["address"], v: string) => setClient((c) => ({ ...c, address: { ...c.address, [k]: v } }));
  const setContact = (id: string, patch: Partial<ConfirmContact>) => setClient((c) => ({ ...c, contacts: c.contacts.map((x) => x.id === id ? { ...x, ...patch } : x) }));

  // stable identity for a roster contact: real id if it exists, else local id
  const ckey = (c: ConfirmContact) => (c.sourceId ?? c.id) as string;
  const contactByKey = (k: string) => client.contacts.find((c) => ckey(c) === k);

  // per-service contact assignment
  const addServiceContact = (key: string, k: string) =>
    setServices((ss) => ss.map((s) => s.key === key && !(s.contactIds ?? []).includes(k) ? { ...s, contactIds: [...(s.contactIds ?? []), k] } : s));
  const removeServiceContact = (key: string, k: string) =>
    setServices((ss) => ss.map((s) => s.key === key
      ? { ...s, contactIds: (s.contactIds ?? []).filter((x) => x !== k), billingContactId: s.billingContactId === k ? null : s.billingContactId }
      : s));
  // create a brand-new roster contact and assign it to this service (editable inline)
  const addNewContactToService = (key: string) => {
    const id = uid();
    setClient((c) => ({ ...c, contacts: [...c.contacts, { id, sourceId: null, name: "", position: "", email: "", phone: "", billing: false }] }));
    addServiceContact(key, id);
  };

  /* ---- versions: pick which proposal is the one sold ---- */
  const swapService = (curKey: string, alt: ConfirmService) =>
    setServices((ss) => ss.map((x) => (x.key === curKey
      ? { ...alt, signingDate: x.signingDate, contactIds: x.contactIds, billingContactId: x.billingContactId, alts: x.alts }
      : x)));
  const swapProduct = (group: string, alt: Omit<ConfirmProduct, "alts">) =>
    setProducts((ps) => ps.map((x) => (x.group === group ? { ...alt, alts: x.alts } : x)));
  const setSigningAll = (iso: string) => { setSignAll(iso); setServices((ss) => ss.map((x) => ({ ...x, signingDate: iso }))); };
  const unsigned = services.filter((x) => !x.signingDate).length;

  /* ---- block + item selection ---- */
  const toggleBlock = (k: BlockKey) => { if (k !== "services") setBlocks((b) => ({ ...b, [k]: !b[k] })); };
  const toggleItem = (k: string) => setOff((s) => { const x = new Set(s); if (x.has(k)) x.delete(k); else x.add(k); return x; });
  const setAll = (keys: string[], on: boolean) => setOff((s) => { const x = new Set(s); keys.forEach((k) => (on ? x.delete(k) : x.add(k))); return x; });
  const destOf = (d: HandoffDoc): DocDest => docDest[d.id] ?? defaultDest(d);
  const revDocs = extras?.docs.filter((d) => d.group === "revenue") ?? [];
  const dealDocs = extras?.docs.filter((d) => d.group === "deal") ?? [];
  const opts = useMemo(() => destOptions(extras?.folders ?? []), [extras]);

  const countOf = (keys: string[], on: boolean) => `${on ? keys.filter((k) => !off.has(k)).length : 0}/${keys.length}`;
  const docCount = (ds: HandoffDoc[], on: boolean) => `${on ? ds.filter((d) => destOf(d) !== "skip").length : 0}/${ds.length}`;

  const buildPackage = (): HandoffPackage => {
    const nameOf = (k?: string | null) => (k ? contactByKey(k)?.name || null : null);
    const docOn = (d: HandoffDoc) => blocks[d.group === "revenue" ? "revdocs" : "dealdocs"] && destOf(d) !== "skip";
    return {
      v: 1, sent_at: new Date().toISOString(), company: clientName,
      blocks: { ...blocks },
      client: blocks.client ? { mode: mode ?? "use", legalName: client.legalName, vatNumber: client.vatNumber, address: client.address, paymentDays } : undefined,
      services: services.map((s) => {
        const bd = bdOf(s);
        return {
          name: s.name, total: bd.total, gross: bd.gross, discount: bd.discount,
          qty: `${bd.qty}${s.unit === "hour" ? "h" : "d"}${bd.multiplierLabel ? ` · ${bd.multiplierLabel}` : ""}`,
          signingDate: s.signingDate,
          contacts: (s.contactIds ?? []).map(nameOf).filter((x): x is string => !!x),
          billTo: nameOf(s.billingContactId),
          rows: bd.rows.map((r) => ({ label: r.label, detail: r.detail, amount: r.amount, discount: r.discount })),
        };
      }),
      deal: blocks.deal && extras ? { ...extras.deal, fields: extras.deal.fields.filter((f) => !off.has(`deal:${f.label}`)) } : undefined,
      revenue: blocks.revenue && extras ? extras.revenue.filter((r) => !off.has(`rev:${r.key}`)) : undefined,
      documents: extras ? extras.docs.filter(docOn).map((d) => ({ ...d, dest: destOf(d), destLabel: destLabel(destOf(d)) })) : [],
      notes: blocks.notes && extras ? extras.notes.filter((n) => !off.has(`note:${n.id}`)) : undefined,
      tasks: blocks.tasks && extras ? extras.tasks.filter((t) => !off.has(`task:${t.id}`)) : undefined,
    };
  };

  const confirm = async () => {
    if (saving || !mode) return;
    if (unsigned) { setErr("Set the signing date first."); return; }
    setSaving(true); setErr(null);
    // Roster passes through so new contacts can be created; per-service contactIds
    // carry the assignment. Drop the legacy UI-only flag if present.
    const roster = client.contacts.map(({ selected, ...c }: any) => c);
    const docMap: Record<string, DocDest> = {};
    (extras?.docs ?? []).forEach((d) => { docMap[d.id] = blocks[d.group === "revenue" ? "revdocs" : "dealdocs"] ? destOf(d) : "skip"; });
    try {
      await onConfirm({
        services, mode, client: { ...client, contacts: roster }, paymentDays,
        share: { blocks, off: Array.from(off), docDest: docMap }, pkg: buildPackage(), products,
      });
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally { setSaving(false); }
  };

  const calcService = calcFor ? services.find((s) => s.key === calcFor) : null;
  const loadingBody = <div className="hx2-loading"><span /><span /><span /></div>;
  const editable = mode === "update";
  const field = (label: string, value: string, set: (v: string) => void, wide = false) => (
    <label className={`hx-ef ${wide ? "hx-ef-2" : ""}`}>
      <input value={value} onChange={(e) => set(e.target.value)} placeholder=" " readOnly={!editable} />
      <span>{label}</span>
    </label>
  );

  const docBlock = (ds: HandoffDoc[], key: "revdocs" | "dealdocs", grouped: boolean) => {
    if (!extras) return loadingBody;
    if (!ds.length) return <p className="hx2-empty">{key === "revdocs" ? "No proposals attached to the calculator versions. Drop them on each version card." : "No documents on this deal."}</p>;
    const row = (d: HandoffDoc) => (
      <DocRow key={d.id} d={d} out={destOf(d) === "skip"} right={
        <Select size="sm" className="hx2-dest-sel" value={destOf(d)} onChange={(v) => setDocDest((m) => ({ ...m, [d.id]: v }))}
          options={opts} disabled={!blocks[key]} aria-label={`Where ${d.name} goes`} />
      } />
    );
    return grouped
      ? groupDocs(ds).map(([g, list]) => <div className="hx2-docgroup" key={g}><span className="hx2-docgroup-t">{g || "Revenue line"}</span>{list.map(row)}</div>)
      : ds.map(row);
  };
  const bulkDest = (ds: HandoffDoc[]) => ds.length > 1 ? (
    <Select size="sm" className="hx2-bulk" value="" placeholder="Send all to…" options={opts}
      onChange={(v) => v && setDocDest((m) => { const x = { ...m }; ds.forEach((d) => { x[d.id] = v; }); return x; })} />
  ) : null;
  const allNone = (keys: string[]) => keys.length > 1 ? (
    <span className="hx2-allnone">
      <button type="button" onClick={() => setAll(keys, true)}>All</button>
      <button type="button" onClick={() => setAll(keys, false)}>None</button>
    </span>
  ) : null;

  const noteKeys = (extras?.notes ?? []).map((n) => `note:${n.id}`);
  const taskKeys = (extras?.tasks ?? []).map((t) => `task:${t.id}`);
  const revKeys = (extras?.revenue ?? []).map((r) => `rev:${r.key}`);
  const dealKeys = (extras?.deal.fields ?? []).map((f) => `deal:${f.label}`);

  const sections: ShellSection[] = [
    {
      key: "client", on: blocks.client, toggle: () => toggleBlock("client"),
      body: (
        <div className="hx2-client">
          {!skipPrompt && (
            <div className="hx2-seg" role="radiogroup" aria-label="Client details">
              <button type="button" role="radio" aria-checked={mode === "use"} className={mode === "use" ? "is-on" : ""} onClick={() => setMode("use")} disabled={!blocks.client}>
                <b>Use existing</b><small>Suggest keeping what management has</small>
              </button>
              <button type="button" role="radio" aria-checked={mode === "update"} className={mode === "update" ? "is-on" : ""} onClick={() => setMode("update")} disabled={!blocks.client}>
                <b>Update details</b><small>Suggest updating with what's below</small>
              </button>
            </div>
          )}
          <div className={`hx2-client-grid ${editable ? "is-edit" : "is-read"}`}>
            <div className="hx-egroup">
              <span className="hx-egroup-t">Legal</span>
              <div className="hx-egrid">
                {field("Legal name", client.legalName, (v) => setClient((c) => ({ ...c, legalName: v })), true)}
                {field("VAT / Tax ID", client.vatNumber, (v) => setClient((c) => ({ ...c, vatNumber: v })))}
                <label className="hx-ef">
                  <input type="number" min={0} value={paymentDays ?? ""} placeholder=" " onChange={(e) => setPaymentDays(e.target.value === "" ? null : Number(e.target.value))} />
                  <span>Payment terms (days net)</span>
                </label>
              </div>
            </div>
            <div className="hx-egroup">
              <span className="hx-egroup-t">Address</span>
              <div className="hx-egrid">
                {field("Street", client.address.street, (v) => setAddr("street", v), true)}
                {field("Number", client.address.number, (v) => setAddr("number", v))}
                {field("Details", client.address.details, (v) => setAddr("details", v))}
                {field("Postal code", client.address.postalCode, (v) => setAddr("postalCode", v))}
                {field("City", client.address.city, (v) => setAddr("city", v))}
                {field("Country", client.address.country, (v) => setAddr("country", v), true)}
              </div>
            </div>
          </div>
          {!skipPrompt && <p className="hx2-hint">Nothing changes on the client yet: management chooses to keep, fill only the blanks, or update when it builds the project.{!editable && !skipPrompt ? " Pick “Update details” to edit the fields." : ""}</p>}
          {skipPrompt && <p className="hx2-hint">The client was created in the previous step with these details.</p>}
        </div>
      ),
    },
    {
      key: "services", on: true, locked: true, count: String(services.length + products.length),
      tools: (
        <span className={`hx2-signall ${signAll ? "" : "is-needed"}`}>
          <span>Signing date</span>
          <DatePicker value={signAll} onChange={setSigningAll} placeholder="Required" />
        </span>
      ),
      body: services.length === 0 && products.length === 0 ? <p className="hx2-empty">No services sold on this deal. It still goes to management with the client and the contract — the services team sets up the work there.</p> : (
        <>
        {services.length > 0 && <div className="hx-cards">
          {services.map((s) => {
            const bd = bdOf(s);
            return (
              <div className="hx-card" key={s.key}>
                <span className="hx-card-accent" aria-hidden="true" />
                <div className="hx-card-top">
                  <span className="hx-card-name">{s.name}</span>
                  {(s.alts?.length ?? 0) > 1 && (
                    <span className="hx2-vers" role="radiogroup" aria-label="Version">
                      {s.alts!.map((a) => (
                        <button type="button" key={a.key} role="radio" aria-checked={a.key === s.key} className={a.key === s.key ? "is-on" : ""}
                          title={`${a.versionLabel} · ${money(bdOf(a).total)}`} onClick={() => a.key !== s.key && swapService(s.key, a)}>{a.versionLabel}</button>
                      ))}
                    </span>
                  )}
                  <button className="hx-card-calc" onClick={() => setCalcFor(s.key)} title="Adjust calculator">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="2" width="16" height="20" rx="2" /><path d="M8 6h8M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01M8 18h4" /></svg>
                  </button>
                </div>
                <div className="hx-card-rows">
                  {bd.rows.map((r, i) => (
                    <div className="hx-crow" key={i}>
                      <span className="hx-crow-l">{r.label}{r.detail ? <em> {r.detail}</em> : null}</span>
                      <span className="hx-crow-r">{money(r.amount)}{r.discount ? <i>−{money(r.discount)}</i> : null}</span>
                    </div>
                  ))}
                </div>
                <div className="hx-card-foot">
                  <span className="hx-card-qty">{bd.qty}{s.unit === "hour" ? "h" : "d"}{bd.multiplierLabel ? ` · ${bd.multiplierLabel}` : ""}</span>
                  <span className="hx-card-total">
                    {bd.discount > 0 && <em className="hx-card-gross">{money(bd.gross)}</em>}
                    <b>{money(bd.total)}</b>
                  </span>
                </div>
                <div className="hx-card-sign">
                  <span>Signing date</span>
                  <DatePicker value={s.signingDate} onChange={(iso) => setService(s.key, { signingDate: iso })} placeholder="Select" />
                </div>
                <div className="hx-svc-contacts">
                  <span className="hx-svc-c-label">Contacts</span>
                  <div className="hx-svc-c-list">
                    {(s.contactIds ?? []).map((k) => {
                      const c = contactByKey(k);
                      if (!c) return null;
                      return !c.sourceId ? (
                        <div className="hx-svc-c-new" key={k}>
                          <div className="hx-svc-c-new-head">
                            <span>New contact</span>
                            <button className="hx-svc-c-x" onClick={() => removeServiceContact(s.key, k)} aria-label="Remove">×</button>
                          </div>
                          <input className="hx-svc-c-nm" value={c.name} onChange={(e) => setContact(c.id, { name: e.target.value })} placeholder="Full name" />
                          <input value={c.position} onChange={(e) => setContact(c.id, { position: e.target.value })} placeholder="Position / role" />
                          <input value={c.email} onChange={(e) => setContact(c.id, { email: e.target.value })} placeholder="Email" />
                          <input value={c.phone} onChange={(e) => setContact(c.id, { phone: e.target.value })} placeholder="Phone" />
                        </div>
                      ) : (
                        <span className={"hx-svc-chip" + (s.billingContactId === k ? " is-bill" : "")} key={k}>
                          {c.name}{s.billingContactId === k ? <i title="Billing contact"> · €</i> : null}
                          <button onClick={() => removeServiceContact(s.key, k)} aria-label="Remove">×</button>
                        </span>
                      );
                    })}
                  </div>
                  <div className="hx-svc-c-add">
                    <Select value="" onChange={(v) => v && addServiceContact(s.key, v)} placeholder="+ Add contact"
                      options={client.contacts
                        .filter((c) => c.sourceId && (c.name || "").trim() && !(s.contactIds ?? []).includes(ckey(c)))
                        .map((c) => ({ value: ckey(c), label: c.position ? `${c.name} · ${c.position}` : c.name }))} />
                    <button className="hx-svc-c-newbtn" onClick={() => addNewContactToService(s.key)}>+ New</button>
                  </div>
                </div>
                <div className="hx-card-bill">
                  <span>Bill to</span>
                  <Select value={s.billingContactId ?? ""} onChange={(v) => setService(s.key, { billingContactId: v || null })} placeholder="Choose contact"
                    options={(s.contactIds ?? [])
                      .map((k) => contactByKey(k))
                      .filter((c): c is ConfirmContact => !!c && !!(c.name || "").trim())
                      .map((c) => ({ value: ckey(c), label: c.position ? `${c.name} · ${c.position}` : c.name }))} />
                </div>
              </div>
            );
          })}
        </div>}
        {products.length > 0 && (
          <div className="hx2-prods">
            <span className="hx2-prods-t">Products <em>The version picked goes to the client's contract</em></span>
            {products.map((p) => {
              const bd = lineBreakdown(p.line, p.calculator, p.catalogBase);
              return (
                <div className="hx2-prod" key={p.group}>
                  <div className="hx2-prod-top">
                    <span className="hx2-kind is-product">Product</span>
                    <b className="hx2-prod-name">{p.name}</b>
                    {p.alts.length > 1 && (
                      <span className="hx2-vers" role="radiogroup" aria-label="Version">
                        {p.alts.map((a) => (
                          <button type="button" key={a.key} role="radio" aria-checked={a.key === p.key} className={a.key === p.key ? "is-on" : ""}
                            title={`${a.versionLabel} · ${money(lineBreakdown(a.line, a.calculator, a.catalogBase).total)}`}
                            onClick={() => a.key !== p.key && swapProduct(p.group, a)}>{a.versionLabel}</button>
                        ))}
                      </span>
                    )}
                    <span className="hx2-prod-sum">{bd.multiplierLabel}</span>
                    <b className="hx2-prod-total">{bd.discount > 0 && <s>{money(bd.gross)}</s>}{money(bd.total)}</b>
                  </div>
                  <div className="hx2-revrows">
                    {bd.rows.map((r, i) => (
                      <div key={i}><span>{r.label}{r.detail ? <em> {r.detail}</em> : null}</span><b>{money(r.amount)}{r.discount ? <i> −{money(r.discount)}</i> : null}</b></div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        </>
      ),
    },
    { key: "deal", on: blocks.deal, toggle: () => toggleBlock("deal"), count: extras ? countOf(dealKeys, blocks.deal) : undefined, tools: allNone(dealKeys),
      body: extras ? <DealView deal={extras.deal} off={off} toggle={toggleItem} disabled={!blocks.deal} /> : loadingBody },
    { key: "revenue", on: blocks.revenue, toggle: () => toggleBlock("revenue"), count: extras ? countOf(revKeys, blocks.revenue) : undefined, tools: allNone(revKeys),
      body: extras ? <RevenueView lines={extras.revenue} money={money} off={off} toggle={toggleItem} disabled={!blocks.revenue} /> : loadingBody },
    { key: "revdocs", on: blocks.revdocs, toggle: () => toggleBlock("revdocs"), count: extras ? docCount(revDocs, blocks.revdocs) : undefined, tools: bulkDest(revDocs),
      body: docBlock(revDocs, "revdocs", true) },
    { key: "dealdocs", on: blocks.dealdocs, toggle: () => toggleBlock("dealdocs"), count: extras ? docCount(dealDocs, blocks.dealdocs) : undefined, tools: bulkDest(dealDocs),
      body: docBlock(dealDocs, "dealdocs", false) },
    { key: "notes", on: blocks.notes, toggle: () => toggleBlock("notes"), count: extras ? countOf(noteKeys, blocks.notes) : undefined, tools: allNone(noteKeys),
      body: extras ? <NotesView notes={extras.notes} off={off} toggle={toggleItem} disabled={!blocks.notes} /> : loadingBody },
    { key: "tasks", on: blocks.tasks, toggle: () => toggleBlock("tasks"), count: extras ? countOf(taskKeys, blocks.tasks) : undefined, tools: allNone(taskKeys),
      body: extras ? <TasksView tasks={extras.tasks} off={off} toggle={toggleItem} disabled={!blocks.tasks} /> : loadingBody },
  ];

  return createPortal(
    <>
      {/* step 1 — small prompt */}
      {mode === null ? (
        <div className="hx-backdrop" style={BACKDROP} onMouseDown={onClose}>
          <div className="hx-prompt" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <span className="hx-prompt-glow" aria-hidden="true" />
            <div className="hx-prompt-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
            </div>
            <h2 className="hx-prompt-title">Client already exists</h2>
            <p className="hx-prompt-sub"><b>{clientName}</b> is already in management. Keep its current details, or update them from this deal?</p>
            <div className="hx-prompt-actions">
              <button className="hx-btn-ghost" onClick={() => setMode("update")}>Update details</button>
              <button className="hx-btn-primary" onClick={() => setMode("use")}>Use existing</button>
            </div>
            <button className="hx-prompt-x" onClick={onClose} aria-label="Cancel">×</button>
          </div>
        </div>
      ) : (
        <HxShell
          eyebrow="Handoff to management"
          title={clientName}
          total={money(total)}
          sections={sections}
          onClose={onClose}
          action={
            <span className="hx2-send">
              <button className="hx-btn-primary hx2-sendbtn" disabled={saving || unsigned > 0} onClick={() => { if (!unsigned) setAskSend(true); }}
                title={unsigned ? "Set the signing date first" : undefined}>
                {unsigned > 0 && <i className="hx2-warn" aria-label="Set the signing date first"><Ico d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" w={2.4} /></i>}
                {saving ? "Sending…" : "Send to management"}
              </button>
              {err && <small className="hx2-err">{err}</small>}
            </span>
          }
        />
      )}

      {askSend && (
        <HxPrompt icon="send" title="Send to management?"
          sub={<>
            {services.length
              ? <><b>{services.length} service{services.length === 1 ? "" : "s"}</b> for <b>{clientName}</b>, {money(total)}.{" "}Management builds the project from what you send, so check the data before it goes.</>
              : <><b>{clientName}</b> goes to management as a client, with its contract and no services yet. The services team decides there what to set up.</>}
          </>}
          ghost="Back to review" primary="Yes, send it"
          onGhost={() => setAskSend(false)} onClose={() => setAskSend(false)}
          onPrimary={() => { setAskSend(false); void confirm(); }} />
      )}

      {/* editable calculator */}
      {calcService && (
        <LineCalcModal
          variant="modern"
          title={calcService.name}
          line={calcService.line}
          calculator={calcService.calculator}
          unit={calcService.unit}
          money={money}
          onApply={(patch) => applyCalc(calcService.key, patch)}
          onClose={() => setCalcFor(null)}
        />
      )}
    </>,
    document.body);
}
