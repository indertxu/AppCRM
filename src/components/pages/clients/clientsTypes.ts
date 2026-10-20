/* Shared types and pure helpers for the Clients and Projects pages.
 *
 * Extracted from ClientsPage so both ClientsPage and the standalone Projects
 * page (and ProjectsView) can import them without depending on each other. */

export interface Contact {
  id: string;
  name: string;
  position: string;
  email: string;
  phone: string;
  billing: boolean;
}
export interface Address {
  street: string; number: string; details: string;
  postalCode: string; city: string; country: string;
}
export interface Phase {
  id: string;
  name: string;
  days: number;
  tasks: { id: string; name: string }[];
}
export interface TeamMember {
  id: string;
  role: string;
  userId: string;
  name: string;
}

/** Client identity only — shared by all its projects. */
export interface Client {
  id: string;
  name: string;
}

/**
 * One role on a project: how many days (or hours) of it were sold, at what
 * rate, and its own discount on that rate. This replaces the fixed
 * consultor / supervision / connector columns: a project carries whichever
 * roles of the catalogue it was sold with.
 */
export interface RoleLine {
  roleId: string;
  days: number;
  rate: number;
  discountMode: "none" | "rate" | "percent";
  discountValue: number;
}

/** One engagement for a client. */
export interface Project {
  id: string;
  clientId: string;
  legalName: string;
  vatNumber: string;
  address: Address;
  contacts: Contact[];
  projectTypeId: string;
  kickoffDate: string;
  signingDate: string;
  consultorDays: number;
  connectorDays: number;
  pricePerDay: number;
  supervisionDays: number;
  supervisionPrice: number;
  taxed: boolean;
  taxRate: number;
  paymentDays: number;
  discountMode: "none" | "rate" | "total" | "percent";
  discountValue: number;
  supervisionDiscountMode: "none" | "rate" | "percent";
  supervisionDiscountValue: number;
  phases: Phase[];
  team: TeamMember[];
  status: string;
  endDate: string;
  /** The roles sold on this project (projects.role_lines). Empty only on rows
   *  not migrated yet — then the legacy columns above stand in, see roleLinesOf. */
  roleLines: RoleLine[];
}

/**
 * What used to be a "project type" is now a service from the catalogue.
 * The field names are kept so the rest of the app keeps compiling, but the
 * data comes from `services` and is stored in `projects.service_id`.
 */
export interface ProjectType {
  id: string; name: string; blueprintId?: string | null;
  /** The service's roles from the catalogue with their list price (prefills a new project). */
  roles?: { roleId: string; price: number; isMain: boolean }[];
}
export interface BlueprintTask { id: string; name: string; percent: number; }
export interface BlueprintPhase { id: string; name: string; percent: number; tasks: BlueprintTask[]; }
export interface Blueprint { id: string; name: string; projectTypeId: string; phases: BlueprintPhase[]; }
export interface ClientRole {
  id: string;
  name: string;
  userIds: string[];
  /** Legacy flag, no longer used: every role now has its own rate. */
  isSupervision: boolean;
  /** Whether time on this role counts towards the consultant's billing
   *  target and bonus (a connector, for instance, doesn't). */
  countsForTarget: boolean;
  color?: string | null;
  sort?: number;
}

/** Colours offered for roles, and the one used when a role has none. */
export const ROLE_COLORS = ["#1fb98a", "#3f7fd8", "#d98324", "#8b5cf6", "#e0574b", "#0ea5a4", "#c2410c", "#64748b"];
export const roleColor = (r: { color?: string | null } | undefined, i = 0) => r?.color || ROLE_COLORS[i % ROLE_COLORS.length];

/** Maps a client_roles row from the database. */
export function mapClientRole(r: any): ClientRole {
  return {
    id: r.id, name: r.name ?? "", userIds: r.user_ids ?? [], isSupervision: !!r.is_supervision,
    countsForTarget: r.counts_for_target == null ? !r.is_connector : !!r.counts_for_target,
    color: r.color ?? null, sort: Number(r.sort) || 0,
  };
}

export const emptyAddress: Address = {
  street: "", number: "", details: "", postalCode: "", city: "", country: "",
};

/**
 * The per-day consultancy rate after discount.
 * - rate:    a fixed € amount knocked off the day price
 * - percent: a % knocked off the day price (900 @ 20% → 720)
 * - none/total: full price (total discounts the whole invoice, not the day)
 */
export function effectiveRate(pricePerDay: number, mode: string, value: number): number {
  if (mode === "rate") return Math.max(0, pricePerDay - value);
  if (mode === "percent") return Math.max(0, pricePerDay * (1 - value / 100));
  return pricePerDay;
}

/**
 * Supervision day rate after ITS OWN discount (independent from consultancy).
 * - rate:    a fixed € amount off the supervision day price
 * - percent: a % off the supervision day price
 * - none:    full supervision price
 */
export function effectiveSupervisionRate(supervisionPrice: number, mode: string, value: number): number {
  if (mode === "rate") return Math.max(0, supervisionPrice - value);
  if (mode === "percent") return Math.max(0, supervisionPrice * (1 - value / 100));
  return supervisionPrice;
}

/* ===================================================================
   Roles on a project
   ===================================================================
   Everything that used to branch on "consultor" / "supervision" /
   "connector" goes through these helpers instead. A project's work is keyed
   by role id; entries carry the role they were logged on. Rows that were
   never migrated fall back to three pseudo-roles with those legacy keys, so
   nothing breaks before the migration SQL has run. */

/** Legacy line keys, only used as role keys for rows that predate roles. */
export const LEGACY_LINES = ["consultor", "supervision", "connector"] as const;
const LEGACY_LABEL: Record<string, string> = { consultor: "Consultancy", supervision: "Project management", connector: "Connector" };

/** The project's role lines, or the legacy columns read as role lines. */
export function roleLinesOf(p: {
  roleLines?: RoleLine[] | null; consultorDays?: number; connectorDays?: number; supervisionDays?: number;
  pricePerDay?: number; supervisionPrice?: number; discountMode?: string; discountValue?: number;
  supervisionDiscountMode?: string; supervisionDiscountValue?: number;
}): RoleLine[] {
  if (p.roleLines && p.roleLines.length) return p.roleLines;
  const out: RoleLine[] = [];
  const dm = (p.discountMode === "rate" || p.discountMode === "percent") ? p.discountMode : "none";
  const sm = (p.supervisionDiscountMode === "rate" || p.supervisionDiscountMode === "percent") ? p.supervisionDiscountMode : "none";
  if (p.consultorDays || !(p.supervisionDays || p.connectorDays)) out.push({ roleId: "consultor", days: Number(p.consultorDays) || 0, rate: Number(p.pricePerDay) || 0, discountMode: dm, discountValue: dm === "none" ? 0 : Number(p.discountValue) || 0 });
  if (p.supervisionDays) out.push({ roleId: "supervision", days: Number(p.supervisionDays) || 0, rate: Number(p.supervisionPrice) || 0, discountMode: sm, discountValue: sm === "none" ? 0 : Number(p.supervisionDiscountValue) || 0 });
  if (p.connectorDays) out.push({ roleId: "connector", days: Number(p.connectorDays) || 0, rate: Number(p.pricePerDay) || 0, discountMode: dm, discountValue: dm === "none" ? 0 : Number(p.discountValue) || 0 });
  return out;
}

/** Reads projects.role_lines (jsonb) from a database row. */
export function parseRoleLines(v: unknown): RoleLine[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x: any) => x && x.roleId).map((x: any) => ({
    roleId: String(x.roleId), days: Number(x.days) || 0, rate: Number(x.rate) || 0,
    discountMode: x.discountMode === "rate" || x.discountMode === "percent" ? x.discountMode : "none",
    discountValue: Number(x.discountValue) || 0,
  }));
}
/** Role lines read straight from a projects row (role_lines, else the legacy columns). */
export function roleLinesOfRow(r: any): RoleLine[] {
  return roleLinesOf({
    roleLines: parseRoleLines(r?.role_lines), consultorDays: Number(r?.consultor_days) || 0, connectorDays: Number(r?.connector_days) || 0,
    supervisionDays: Number(r?.supervision_days) || 0, pricePerDay: Number(r?.price_per_day) || 0, supervisionPrice: Number(r?.supervision_price) || 0,
    discountMode: r?.discount_mode ?? "none", discountValue: Number(r?.discount_value) || 0,
    supervisionDiscountMode: r?.supervision_discount_mode ?? "none", supervisionDiscountValue: Number(r?.supervision_discount_value) || 0,
  });
}

/** A role line's rate after its own discount. */
export const lineRate = (l: RoleLine) => effectiveRate(l.rate, l.discountMode, l.discountValue);
/** € off the whole project (the "total" discount), 0 when there is none. */
export const totalDiscountOf = (p: { discountMode?: string; discountValue?: number }) => (p.discountMode === "total" ? Number(p.discountValue) || 0 : 0);
/** Days (or hours) sold on the project, all roles together. */
export const signedOf = (p: Parameters<typeof roleLinesOf>[0]) => roleLinesOf(p).reduce((s, l) => s + l.days, 0);
/** Days sold on one role. */
export const signedOn = (p: Parameters<typeof roleLinesOf>[0], roleKey: string) => roleLinesOf(p).filter((l) => l.roleId === roleKey).reduce((s, l) => s + l.days, 0);

/**
 * The rate an entry bills at: its role's line on the project. An entry whose
 * role isn't on the project (or has none) bills at the project's first line.
 */
export function rateOn(lines: RoleLine[], roleKey: string | null | undefined): number {
  const l = lines.find((x) => x.roleId === roleKey) ?? lines[0];
  return l ? lineRate(l) : 0;
}

/** Role key of a calendar entry: its role, else its legacy billing line.
 *  Closing / sales time keeps its line: it never belongs to a project role. */
export function roleKeyOf(e: { roleId?: string | null; role_id?: string | null; line?: string | null; billing_line?: string | null }): string {
  const line = e.line || e.billing_line || "";
  if (line === "closure" || line === "sales") return line;
  return (e.roleId || e.role_id || line || "consultor") as string;
}

/** Sorts roles the way they are listed everywhere (catalogue order, then name). */
export const sortRoles = <T extends { sort?: number; name: string }>(rs: T[]) =>
  [...rs].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name));

/** The legacy columns written next to role_lines, so any older reader still
 *  sees sensible totals: counting roles as consultancy, the rest as connector. */
export function legacyColumnsOf(lines: RoleLine[], roles: { id: string; countsForTarget: boolean }[]) {
  const counts = (l: RoleLine) => roleCounts(l.roleId, roles);
  const first = lines.find(counts) ?? lines[0];
  return {
    consultor_days: lines.filter(counts).reduce((s, l) => s + l.days, 0),
    connector_days: lines.filter((l) => !counts(l)).reduce((s, l) => s + l.days, 0),
    supervision_days: 0,
    price_per_day: first ? first.rate : 0,
    supervision_price: 0,
    supervision_discount_mode: "none",
    supervision_discount_value: 0,
  };
}

/** Display name of a role key (a catalogue role, or a legacy line). */
export function roleNameOf(key: string, roles: { id: string; name: string }[]): string {
  return roles.find((r) => r.id === key)?.name || LEGACY_LABEL[key] || "Role";
}
/** Whether time on this role counts for the consultant's target and bonus. */
export function roleCounts(key: string | null | undefined, roles: { id: string; countsForTarget: boolean }[]): boolean {
  if (!key) return true;
  if (key === "closure" || key === "sales") return false;
  const r = roles.find((x) => x.id === key);
  if (r) return r.countsForTarget;
  return key !== "connector";
}

export function projectValue(p: Project): number {
  const gross = roleLinesOf(p).reduce((s, l) => s + l.days * lineRate(l), 0);
  return Math.max(0, gross - totalDiscountOf(p));
}
/** Value at list rates, before any discount (for "you saved" figures). */
export function projectListValue(p: Project): number {
  return roleLinesOf(p).reduce((s, l) => s + l.days * l.rate, 0);
}
/**
 * The tenant's real role for each legacy line key: consultancy → the main
 * consultant role, supervision → the supervision role, connector → the role
 * that doesn't count. Used to read rows written before roles existed.
 */
export function legacyRoleMap(roles: ClientRole[]): Record<string, string> {
  const s = sortRoles(roles);
  const main = s.find((r) => /^main/i.test(r.name) && r.countsForTarget) ?? s.find((r) => r.countsForTarget && !r.isSupervision) ?? s[0];
  const sup = s.find((r) => r.isSupervision);
  const conn = s.find((r) => r.name.trim().toLowerCase() === "connector") ?? s.find((r) => !r.countsForTarget);
  const m: Record<string, string> = {};
  if (main) m.consultor = main.id;
  if (sup) m.supervision = sup.id;
  if (conn) m.connector = conn.id;
  return m;
}
/** A role key with legacy lines swapped for the tenant's real role. */
export const resolveRoleKey = (key: string, map: Record<string, string>) => map[key] ?? key;
/** A project's role lines with legacy keys swapped for real roles (merging duplicates). */
export function resolvedLinesOf(p: Parameters<typeof roleLinesOf>[0], map: Record<string, string>): RoleLine[] {
  const out: RoleLine[] = [];
  for (const l of roleLinesOf(p)) {
    const roleId = resolveRoleKey(l.roleId, map);
    const same = out.find((x) => x.roleId === roleId);
    if (same) same.days += l.days;
    else out.push({ ...l, roleId });
  }
  return out;
}

// ---- Company logos from the website (no API key; the browser loads them) ----
/** "https://www.acme.es/about" → "acme.es" (null when there is no usable domain). */
export function domainOf(url?: string | null): string | null {
  const raw = String(url ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (!host.includes(".") || /(^|\.)linkedin\.com$/.test(host)) return null;
    return host;
  } catch { return null; }
}
/** Logo candidates for a company, best first: the site's icon at a large size, then smaller fallbacks.
 *  Use with <img onError> moving to the next one, and initials when all fail. */
export function logoCandidates(website?: string | null): string[] {
  const d = domainOf(website);
  if (!d) return [];
  return [
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=128`,
    `https://icons.duckduckgo.com/ip3/${encodeURIComponent(d)}.ico`,
  ];
}
