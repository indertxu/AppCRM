/* BASE · Orbit — the one page for contacts and companies (src/base/pages/orbit/).
   Shared types between the Orbit page and the contact / company pages it hosts. */

export type OrbitView = "all" | "contacts" | "companies" | "clients";
export const ORBIT_VIEWS: OrbitView[] = ["all", "contacts", "companies", "clients"];
/** The view in the address: /orbit (all), ?view=contacts (old links: people), ?view=companies, ?view=clients. */
export const viewOf = (v: string | null): OrbitView =>
  v === "contacts" || v === "people" ? "contacts" : v === "companies" ? "companies" : v === "clients" ? "clients" : "all";
export type OrbitKind = "contact" | "company";

/** What a new contact and a new company have in common: kept when you switch kind in the "New" panel. */
export const DRAFT_KEYS = ["email", "phone", "street", "addr_number", "postal_code", "city", "province", "country", "notes"] as const;
export type OrbitDraft = Partial<Record<(typeof DRAFT_KEYS)[number], string>>;

/** The fields of a record that carry over to the other kind (only the filled ones). */
export function draftOf(rec: object): OrbitDraft {
  const out: OrbitDraft = {};
  for (const k of DRAFT_KEYS) {
    const v = (rec as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) out[k] = v;
  }
  return out;
}

/** A contacts / companies list living inside Orbit: "New …" goes through Orbit, and Orbit tells it when to read again. */
export interface OrbitHost {
  onNew: (kind: OrbitKind) => void;
  /** Goes up after a save in an Orbit panel: the list reads itself again. */
  refresh: number;
}

/** A contacts / companies page mounted by Orbit only for its editor: a new record (with the kind switch) or one record. */
export interface OrbitOnly {
  /** Open this record; none = a new one. */
  id?: string;
  /** What was typed in the other kind before switching. */
  draft?: OrbitDraft;
  onClose: () => void;
  /** Something was saved or deleted (Orbit refreshes the list underneath). */
  onSaved: () => void;
  /** New record only: switch to the other kind, keeping what the two have in common. */
  onSwitch: (kind: OrbitKind, draft: OrbitDraft) => void;
  /** Opened by a switch (the panel is already on screen: no entrance). */
  swapped?: boolean;
}

/** What the editors get to show the Contact | Company switch in their header (new records only). */
export interface OrbitKindProp {
  onSwitch: (kind: OrbitKind, draft: OrbitDraft) => void;
  swapped?: boolean;
}
