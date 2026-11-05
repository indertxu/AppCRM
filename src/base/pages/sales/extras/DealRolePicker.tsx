import type { CSSProperties } from "react";
import { ROLE_COLORS, type SalesRole } from "./salesRolesApi";
import "./DealRolePicker.css";

/**
 * The sales role someone plays on one deal. One fitting role: shown as a chip.
 * Several: pick which one (radio chips). `describe` adds a short line about the
 * chosen role (e.g. "sees up to Qualified, then → Antonio").
 */
export default function DealRolePicker({ roles, value, onChange, disabled = false, describe, personName }: {
  roles: SalesRole[];
  value: string | null;
  onChange: (roleId: string) => void;
  disabled?: boolean;
  describe?: (r: SalesRole) => string | null;
  personName?: string;
}) {
  if (!roles.length) return null;
  const color = (r: SalesRole) => r.color || ROLE_COLORS[Math.abs(r.sort) % ROLE_COLORS.length];
  const chosen = roles.length === 1 ? roles[0] : roles.find((r) => r.id === value) ?? null;
  const note = chosen && describe ? describe(chosen) : null;
  if (roles.length === 1) {
    return (
      <span className="drp is-single">
        <span className="drp-chip is-on is-static" style={{ ["--c" as string]: color(roles[0]) } as CSSProperties}>{roles[0].name}</span>
        {note && <small className="drp-note">{note}</small>}
      </span>
    );
  }
  return (
    <span className={`drp ${chosen ? "" : "is-missing"}`}>
      <span className="drp-chips" role="radiogroup" aria-label={personName ? `Role ${personName} plays on this deal` : "Role on this deal"}>
        <span className="drp-label">{chosen ? "Acting as" : "Pick a role"}</span>
        {roles.map((r) => (
          <button key={r.id} type="button" role="radio" aria-checked={chosen?.id === r.id} disabled={disabled}
            className={`drp-chip ${chosen?.id === r.id ? "is-on" : ""}`} style={{ ["--c" as string]: color(r) } as CSSProperties}
            onClick={() => onChange(r.id)}>
            {r.name}
          </button>
        ))}
      </span>
      {note && <small className="drp-note">{note}</small>}
    </span>
  );
}