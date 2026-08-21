/* eslint-disable @typescript-eslint/no-explicit-any */
import { supabase } from "../../api/supabase";

// One change event.
export interface HistoryEvent {
  id: string;
  entity_type: "user" | "dept";
  entity_id: string;
  field: string;
  value: any;
  effective_date: string; // YYYY-MM-DD
  note: string | null;
  created_at: string;
}

// Human-readable labels for the versioned fields (for auto notes).
const FIELD_LABEL: Record<string, string> = {
  department: "department",
  manager_id: "reports to",
  salary: "salary",
  role: "security role",
  placed: "on the map",
  parent_id: "led by",
  security_role: "default security role",
};

// Only these fields are versioned over time. Everything else is "latest value
// only" — it's saved to the live row but never generates a history event, to
// keep the log lean and meaningful.
//   user: department, manager (reports-to), salary (wage), security role
//   dept: placed (exists on the map), parent (led-by), default security role
const TRACK_HISTORY: Record<"user" | "dept", Set<string>> = {
  user: new Set(["department", "manager_id", "salary", "role"]),
  dept: new Set(["placed", "parent_id", "security_role"]),
};

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
export function mondayOf(dateISO: string) {
  const d = new Date(dateISO + "T00:00:00");
  const day = (d.getDay() + 6) % 7; // 0 = Monday
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
}

// Record a set of field changes for one entity, on a given effective date.
// If an event for the same entity+field+date exists, replace it (so re-editing
// the same day doesn't pile up duplicate rows — "each date holds its own value").
// `resolve(field, value)` turns raw values (ids, keys) into readable text for notes.
export async function recordChanges(
  entityType: "user" | "dept",
  entityId: string,
  patch: Record<string, any>,
  effectiveDate: string,
  nameForNote: string,
  resolve?: (field: string, value: any) => string,
) {
  for (const [field, value] of Object.entries(patch)) {
    if (!TRACK_HISTORY[entityType].has(field)) continue;
    const label = FIELD_LABEL[field] ?? field;
    const shown = resolve
      ? resolve(field, value)
      : (value === null || value === "" ? "cleared" : String(value));
    const note = `${nameForNote}: ${label} → ${shown}`;
    // delete any existing event for this entity+field+date, then insert the new one
    await supabase.from("org_history")
      .delete()
      .eq("entity_type", entityType).eq("entity_id", entityId)
      .eq("field", field).eq("effective_date", effectiveDate);
    await supabase.from("org_history").insert({
      entity_type: entityType, entity_id: entityId, field, value,
      effective_date: effectiveDate, note,
    });
  }
}

// Load all history up to and including a date (for reconstructing state).
export async function loadHistoryUpTo(dateISO: string): Promise<HistoryEvent[]> {
  const { data } = await supabase
    .from("org_history")
    .select("*")
    .lte("effective_date", dateISO)
    .order("effective_date", { ascending: true })
    .order("created_at", { ascending: true });
  return (data ?? []) as HistoryEvent[];
}

// Load the change notes within a given week (Monday..Sunday) for the side panel.
export async function loadWeekNotes(mondayISO: string): Promise<HistoryEvent[]> {
  const start = mondayISO;
  const end = new Date(mondayISO + "T00:00:00");
  end.setDate(end.getDate() + 6);
  const endISO = end.toISOString().slice(0, 10);
  const { data } = await supabase
    .from("org_history")
    .select("*")
    .gte("effective_date", start)
    .lte("effective_date", endISO)
    .order("effective_date", { ascending: true })
    .order("created_at", { ascending: true });
  return (data ?? []) as HistoryEvent[];
}

// Which weeks (Mondays) have at least one change — for calendar dots.
export async function loadChangeWeeks(): Promise<string[]> {
  const { data } = await supabase.rpc("org_change_weeks");
  return ((data ?? []) as any[]).map((r) => r.week);
}

// Reconstruct entity field-values as of a date: apply events in order,
// latest effective_date (then created_at) wins per (entity, field).
export function reconstruct(events: HistoryEvent[]) {
  const users: Record<string, Record<string, any>> = {};
  const depts: Record<string, Record<string, any>> = {};
  for (const e of events) {
    const bag = e.entity_type === "user" ? users : depts;
    if (!bag[e.entity_id]) bag[e.entity_id] = {};
    bag[e.entity_id][e.field] = e.value; // events are ordered, so last write wins
  }
  return { users, depts };
}