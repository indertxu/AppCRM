/* eslint-disable @typescript-eslint/no-explicit-any */
import DatePicker from "../../../framework/DatePicker";
import MultiSelect from "../../../framework/MultiSelect";
import { useEffect, useState } from "react";
import { selectValues, type TrackingField } from "./trackingFieldsApi";
import { partnerList } from "../../companies/companiesApi";

/** A dropdown field called "…partner…" lists the partners (companies with a partner type), not its own options. */
export const isPartnerField = (f: { label: string; type: string }) => /partner/i.test(f.label) && (f.type === "select" || f.type === "multiselect");
/** The partners' names, for such a field (read once per visit). */
export function usePartnerNames(on: boolean): string[] | null {
  const [names, setNames] = useState<string[] | null>(null);
  useEffect(() => {
    if (!on) return;
    let off = false;
    partnerList().then((r) => { if (!off) setNames(r.map((x) => x.name)); }).catch(() => {});
    return () => { off = true; };
  }, [on]);
  return on ? names : null;
}

/**
 * The control for one custom field, by type. Fully controlled: the caller
 * holds the value. `onBlur` lets a caller save typed text once, when the
 * person leaves the box, instead of on every key.
 */
export default function FieldInput({ field: f, value, onChange, onBlur, disabled }: {
  field: TrackingField;
  value: any;
  onChange: (v: any) => void;
  onBlur?: () => void;
  disabled?: boolean;
}) {
  const partners = usePartnerNames(isPartnerField(f));
  if (f.type === "number") {
    return (
      <input type="number" inputMode="decimal" className="tfi-in" value={value ?? ""} disabled={disabled}
        onFocus={(e) => e.target.select()} onBlur={onBlur}
        onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))} />
    );
  }
  if (f.type === "date") {
    return <DatePicker value={value ? String(value).slice(0, 10) : ""} onChange={(v) => onChange(v || "")} placeholder="Pick a date" />;
  }
  if (f.type === "boolean") {
    // Three states on purpose: not answered yet, yes, no.
    return (
      <div className={`tfi-yn ${disabled ? "is-disabled" : ""}`} role="radiogroup" aria-label={f.label}>
        {([[true, "Yes"], [false, "No"]] as const).map(([v, l]) => (
          <button key={l} type="button" role="radio" aria-checked={value === v} disabled={disabled}
            className={value === v ? "is-on" : ""} onClick={() => onChange(value === v ? "" : v)}>{l}</button>
        ))}
      </div>
    );
  }
  if (f.type === "select") {
    // A dropdown takes several options at once (a value saved before as one option still reads).
    const picked = selectValues(value);
    const base = partners ?? f.options;
    const opts = [...base, ...picked.filter((v) => !base.includes(v))];
    return (
      <MultiSelect values={picked} onChange={(vs) => onChange(vs.length ? vs : "")} placeholder="Choose…"
        options={opts.map((o) => ({ value: o, label: o }))} />
    );
  }
  return (
    <input className="tfi-in" value={value ?? ""} disabled={disabled} onBlur={onBlur}
      onChange={(e) => onChange(e.target.value)} />
  );
}
