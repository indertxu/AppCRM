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
}

/**
 * What used to be a "project type" is now a service from the catalogue.
 * The field names are kept so the rest of the app keeps compiling, but the
 * data comes from `services` and is stored in `projects.service_id`.
 */
export interface ProjectType { id: string; name: string; blueprintId?: string | null; }
export interface BlueprintTask { id: string; name: string; percent: number; }
export interface BlueprintPhase { id: string; name: string; percent: number; tasks: BlueprintTask[]; }
export interface Blueprint { id: string; name: string; projectTypeId: string; phases: BlueprintPhase[]; }
export interface ClientRole { id: string; name: string; userIds: string[]; isSupervision: boolean; }

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

export function projectValue(p: Project): number {
  const totalConsult = p.consultorDays + p.connectorDays;
  const rate = effectiveRate(p.pricePerDay, p.discountMode, p.discountValue);
  const supRate = effectiveSupervisionRate(p.supervisionPrice, p.supervisionDiscountMode, p.supervisionDiscountValue);
  const gross = totalConsult * rate + p.supervisionDays * supRate;
  return p.discountMode === "total" ? Math.max(0, gross - p.discountValue) : gross;
}