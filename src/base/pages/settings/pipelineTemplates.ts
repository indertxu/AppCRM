/* =====================================================================
   Pipeline library (Base · Settings › Pipelines)
   15 ready-made sales pipelines, one per sector we sell to, plus a
   generic one. Each phase carries a close probability (how likely a deal
   in it ends Won), used by the forecast. Creating one writes a normal
   pipeline: phases one under the other, arrows between them, Won / Lost
   at the end — the same shape the editor builds.
   ===================================================================== */
import { supabase } from "../../../components/api/supabase";
import type { Pipeline } from "./pipelineApi";

export interface TplPhase { name: string; prob: number; tip?: string; }
export interface PipelineTemplate {
  key: string;
  sector: string;          // shown on the card
  group: TplGroup;
  name: string;            // the pipeline's name when created
  blurb: string;           // one line: who it's for
  color: string;
  icon: string;            // svg path(s), 24×24, stroke
  phases: TplPhase[];
}
export type TplGroup = "Professional services" | "Health" | "Tech" | "Property & building" | "Industry & trade" | "Education & events" | "Marketing & people";
export const TPL_GROUPS: TplGroup[] = ["Professional services", "Health", "Tech", "Property & building", "Industry & trade", "Education & events", "Marketing & people"];

const I = {
  scale: "M12 3v18M7 21h10M5 7h14M5 7l-3 7a3 3 0 0 0 6 0zM19 7l-3 7a3 3 0 0 0 6 0z",
  health: "M12 21s-7-4.4-9.3-9A5.2 5.2 0 0 1 12 6.3 5.2 5.2 0 0 1 21.3 12C19 16.6 12 21 12 21zM12 9.5v5M9.5 12h5",
  code: "M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14",
  cloud: "M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 9.2 4.4 4.4 0 0 0 7 18z",
  calc: "M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM8 7h8M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01M8.5 15h.01M12 15h.01M15.5 15h.01M8.5 18.3h.01M12 18.3h.01M15.5 18.3h.01",
  brief: "M4 8h16v11H4zM9 8V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M4 13h16",
  mega: "M4 10v4h3l6 4V6L7 10zM16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11",
  home: "M3 11l9-7 9 7M5 9.5V20h14V9.5M10 20v-5h4v5",
  build: "M3 21h18M5 21V10l7-5 7 5v11M9 21v-6h6v6M9 11h.01M15 11h.01",
  compass: "M12 3l1.6 3.4M12 3l-1.6 3.4M10.4 6.4L5 20M13.6 6.4L19 20M7.4 14h9.2",
  shield: "M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6zM9 12l2 2 4-4",
  cap: "M2 9l10-5 10 5-10 5zM6 11v5c3.5 2.5 8.5 2.5 12 0v-5M21 9v6",
  factory: "M3 21V11l5 3V11l5 3V11l5 3V5h3v16zM7 18h2M12 18h2M17 18h2",
  people: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14a6.4 6.4 0 0 1 3.5 6",
  glass: "M8 3h8l-1 7a3 3 0 0 1-6 0zM12 13v6M8.5 21h7",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6",
};

export const TEMPLATES: PipelineTemplate[] = [
  { key: "law", sector: "Law firm", group: "Professional services", name: "New clients · Law firm", color: "#7b5cd6", icon: I.scale,
    blurb: "From the first call to a signed engagement letter.",
    phases: [
      { name: "New inquiry", prob: 10, tip: "Someone asked about a case" },
      { name: "Conflict check", prob: 20, tip: "Make sure you can take it" },
      { name: "First consultation", prob: 40 },
      { name: "Fee proposal sent", prob: 60 },
      { name: "Engagement letter signed", prob: 90 },
    ] },
  { key: "clinic", sector: "Medical or dental clinic", group: "Health", name: "New patients · Clinic", color: "#e0567a", icon: I.health,
    blurb: "From a request to an accepted treatment plan.",
    phases: [
      { name: "Appointment request", prob: 15 },
      { name: "Appointment booked", prob: 30 },
      { name: "First visit done", prob: 50 },
      { name: "Treatment plan presented", prob: 70 },
      { name: "Plan accepted", prob: 90 },
    ] },
  { key: "software", sector: "Software implementation", group: "Tech", name: "Projects · Software implementation", color: "#2f7fe0", icon: I.code,
    blurb: "Integrators and ERP / CRM partners selling projects.",
    phases: [
      { name: "Lead", prob: 5 },
      { name: "Discovery call", prob: 15 },
      { name: "Demo", prob: 30 },
      { name: "Scoping workshop", prob: 45 },
      { name: "Proposal sent", prob: 60 },
      { name: "Negotiation", prob: 75 },
      { name: "Contract signed", prob: 95 },
    ] },
  { key: "saas", sector: "SaaS / software product", group: "Tech", name: "New business · SaaS", color: "#3aa0d8", icon: I.cloud,
    blurb: "Subscriptions with a demo and a trial.",
    phases: [
      { name: "Lead", prob: 5 },
      { name: "Qualified", prob: 15 },
      { name: "Demo done", prob: 30 },
      { name: "Free trial", prob: 45 },
      { name: "Proposal", prob: 65 },
      { name: "Negotiation", prob: 80 },
    ] },
  { key: "accounting", sector: "Accounting & tax advisory", group: "Professional services", name: "New clients · Advisory", color: "#12b57f", icon: I.calc,
    blurb: "Gestorías, accountants and tax advisers.",
    phases: [
      { name: "Inquiry", prob: 10 },
      { name: "Needs review", prob: 30 },
      { name: "Fee proposal sent", prob: 55 },
      { name: "Documents received", prob: 80 },
      { name: "Client onboarded", prob: 95 },
    ] },
  { key: "consulting", sector: "Consulting", group: "Professional services", name: "Engagements · Consulting", color: "#0f8a6a", icon: I.brief,
    blurb: "Strategy, management and specialist consultants.",
    phases: [
      { name: "Lead", prob: 5 },
      { name: "Discovery meeting", prob: 20 },
      { name: "Diagnosis", prob: 35 },
      { name: "Proposal sent", prob: 55 },
      { name: "Negotiation", prob: 75 },
    ] },
  { key: "agency", sector: "Marketing agency", group: "Marketing & people", name: "New accounts · Agency", color: "#f08a24", icon: I.mega,
    blurb: "Marketing, design and communication agencies.",
    phases: [
      { name: "Lead", prob: 5 },
      { name: "Briefing", prob: 25 },
      { name: "Pitch / proposal", prob: 45 },
      { name: "Negotiation", prob: 70 },
      { name: "Kick-off booked", prob: 90 },
    ] },
  { key: "realestate", sector: "Real estate agency", group: "Property & building", name: "Buyers · Real estate", color: "#c9792b", icon: I.home,
    blurb: "Agents working with buyers from search to the notary.",
    phases: [
      { name: "New buyer", prob: 5 },
      { name: "Needs qualified", prob: 15 },
      { name: "Viewings", prob: 30 },
      { name: "Offer made", prob: 55 },
      { name: "Deposit paid", prob: 80 },
      { name: "Notary booked", prob: 95 },
    ] },
  { key: "construction", sector: "Construction & renovation", group: "Property & building", name: "Works · Construction", color: "#8a6d3b", icon: I.build,
    blurb: "Builders, renovations and installers.",
    phases: [
      { name: "Request", prob: 10 },
      { name: "Site visit", prob: 25 },
      { name: "Quote sent", prob: 45 },
      { name: "Quote revised", prob: 65 },
      { name: "Contract signed", prob: 90 },
    ] },
  { key: "architecture", sector: "Architecture & engineering", group: "Property & building", name: "Commissions · Architecture", color: "#5b6fb0", icon: I.compass,
    blurb: "Studios quoting fees for projects and permits.",
    phases: [
      { name: "Inquiry", prob: 10 },
      { name: "Briefing", prob: 25 },
      { name: "Feasibility study", prob: 40 },
      { name: "Fee proposal", prob: 60 },
      { name: "Commission signed", prob: 90 },
    ] },
  { key: "insurance", sector: "Insurance broker", group: "Professional services", name: "Policies · Insurance", color: "#2c8f9e", icon: I.shield,
    blurb: "Brokers comparing quotes for companies and families.",
    phases: [
      { name: "Lead", prob: 10 },
      { name: "Needs analysis", prob: 25 },
      { name: "Quotes compared", prob: 45 },
      { name: "Proposal sent", prob: 65 },
      { name: "Policy issued", prob: 95 },
    ] },
  { key: "training", sector: "Training & academies", group: "Education & events", name: "Enrolments · Training", color: "#d6a21e", icon: I.cap,
    blurb: "Schools, academies and corporate training.",
    phases: [
      { name: "Inquiry", prob: 10 },
      { name: "Info session", prob: 30 },
      { name: "Application", prob: 55 },
      { name: "Enrolled", prob: 80 },
      { name: "Paid", prob: 95 },
    ] },
  { key: "industrial", sector: "Industrial B2B & distribution", group: "Industry & trade", name: "Orders · Industrial B2B", color: "#5a6b78", icon: I.factory,
    blurb: "Manufacturers and distributors with samples and specs.",
    phases: [
      { name: "Lead", prob: 5 },
      { name: "Qualified", prob: 15 },
      { name: "Visit / meeting", prob: 30 },
      { name: "Samples & specs", prob: 45 },
      { name: "Quote sent", prob: 60 },
      { name: "Negotiation", prob: 75 },
      { name: "Order received", prob: 95 },
    ] },
  { key: "recruitment", sector: "Recruitment & HR", group: "Marketing & people", name: "Searches · Recruitment", color: "#b0558f", icon: I.people,
    blurb: "Agencies winning search and selection mandates.",
    phases: [
      { name: "Lead", prob: 10 },
      { name: "Job briefing", prob: 30 },
      { name: "Proposal sent", prob: 50 },
      { name: "Terms agreed", prob: 75 },
      { name: "Search started", prob: 95 },
    ] },
  { key: "events", sector: "Hotels & events", group: "Education & events", name: "Groups & events · Hospitality", color: "#c44f3d", icon: I.glass,
    blurb: "Groups, weddings, congresses and corporate events.",
    phases: [
      { name: "Inquiry", prob: 10 },
      { name: "Availability checked", prob: 25 },
      { name: "Proposal sent", prob: 45 },
      { name: "Site visit", prob: 65 },
      { name: "Contract & deposit", prob: 90 },
    ] },
];

/** For "something else": the classic five steps. */
export const GENERIC: PipelineTemplate = {
  key: "generic", sector: "Something else", group: "Professional services", name: "Sales pipeline", color: "#12b57f", icon: I.spark,
  blurb: "A classic sales line you can shape to anything.",
  phases: [
    { name: "Lead", prob: 10 },
    { name: "Qualified", prob: 25 },
    { name: "Proposal sent", prob: 50 },
    { name: "Negotiation", prob: 75 },
  ],
};

const STEP_Y = 140;
const uuid = () => crypto.randomUUID();

/**
 * Create a sales pipeline from phases (a template, or what the guide built):
 * phases one under the other, an arrow from each to the next, and Won / Lost
 * at the end — like the editor does. Returns the pipeline or why it failed.
 */
export async function createPipelineFrom(opts: {
  name: string; phases: TplPhase[]; endings?: boolean; isSales?: boolean; folderId?: string | null; description?: string | null;
}): Promise<Pipeline | string> {
  const phases = opts.phases.map((p) => ({ ...p, name: p.name.trim() })).filter((p) => p.name);
  if (!phases.length) return "Add at least one phase.";
  const row: Record<string, unknown> = { name: opts.name.trim() || "Sales pipeline", is_sales: opts.isSales ?? true };
  if (opts.folderId) row.folder_id = opts.folderId;
  if (opts.description) row.description = opts.description;
  let ins = await supabase.from("pipelines").insert(row).select().single();
  if (ins.error && row.description) { delete row.description; ins = await supabase.from("pipelines").insert(row).select().single(); }
  if (ins.error || !ins.data) return ins.error?.message ?? "Couldn't create the pipeline: your user isn't allowed to.";
  const pipe = ins.data as Pipeline;
  const undo = async (why: string) => { await supabase.from("pipelines").delete().eq("id", pipe.id); return why; };

  const ids = phases.map(() => uuid());
  const rows: Record<string, unknown>[] = phases.map((p, i) => ({
    id: ids[i], pipeline_id: pipe.id, name: p.name, pos_x: 0, pos_y: i * STEP_Y, close_probability: Math.max(0, Math.min(100, Math.round(p.prob))),
  }));
  let winId: string | null = null, lossId: string | null = null;
  if (opts.endings !== false) {
    winId = uuid(); lossId = uuid();
    rows.push({ id: winId, pipeline_id: pipe.id, name: "Won", pos_x: 0, pos_y: phases.length * STEP_Y, sales_outcome: "win", close_probability: 100 });
    rows.push({ id: lossId, pipeline_id: pipe.id, name: "Lost", pos_x: 260, pos_y: phases.length * STEP_Y, sales_outcome: "loss", close_probability: 0 });
  }
  const ph = await supabase.from("pipeline_phases").insert(rows).select("id");
  if (ph.error || (ph.data ?? []).length < rows.length) return undo(`Couldn't add the phases: ${ph.error?.message ?? "your user isn't allowed to."}`);

  const pairs: [string, string][] = ids.slice(1).map((id, i) => [ids[i], id]);
  const last = ids[ids.length - 1];
  if (winId) pairs.push([last, winId]);
  if (lossId) pairs.push([last, lossId]);
  if (pairs.length) {
    const ln = await supabase.from("pipeline_links").insert(pairs.map(([a, b]) => ({ pipeline_id: pipe.id, from_phase: a, to_phase: b }))).select("id");
    if (ln.error) return undo(`Couldn't link the phases: ${ln.error.message}`);
  }
  return pipe;
}

/** "Sales pipeline", or "Sales pipeline (2)" when that name is taken. */
export function freeName(want: string, taken: string[]): string {
  const t = new Set(taken.map((x) => x.trim().toLowerCase()));
  if (!t.has(want.trim().toLowerCase())) return want;
  for (let i = 2; i < 100; i++) { const n = `${want} (${i})`; if (!t.has(n.toLowerCase())) return n; }
  return want;
}
