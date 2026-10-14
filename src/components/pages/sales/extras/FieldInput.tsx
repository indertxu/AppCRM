/* eslint-disable @typescript-eslint/no-explicit-any */
import DatePicker from "../../../framework/DatePicker";
import Select from "../../../framework/Select";
import type { TrackingField } from "./trackingFieldsApi";

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
    const opts = f.options.includes(value) || value == null || value === "" ? f.options : [...f.options, String(value)];
    return (
      <Select value={value ?? ""} onChange={(v) => onChange(v)} placeholder="Choose…"
        options={[{ value: "", label: "—" }, ...opts.map((o) => ({ value: o, label: o }))]} />
    );
  }
  return (
    <input className="tfi-in" value={value ?? ""} disabled={disabled} onBlur={onBlur}
      onChange={(e) => onChange(e.target.value)} />
  );
}
