/* eslint-disable @typescript-eslint/no-explicit-any */
import DatePicker from "../../../framework/DatePicker";
import MultiSelect from "../../../framework/MultiSelect";
import { selectValues, type TrackingField } from "./trackingFieldsApi";

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
    // A dropdown takes several options at once (a value saved before as one option still reads).
    const picked = selectValues(value);
    const opts = [...f.options, ...picked.filter((v) => !f.options.includes(v))];
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
