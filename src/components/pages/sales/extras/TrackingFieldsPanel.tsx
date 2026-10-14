/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from "react";
import FieldInput from "./FieldInput";
import { saveTrackingCustom, isEmptyValue, type TrackingField } from "./trackingFieldsApi";
import "./TrackingFields.css";

/**
 * "Details" card on a deal: every custom field, editable in place.
 * Choices (dropdown, yes/no, date) save the moment they change; typed text
 * and numbers save when you leave the box.
 */
export default function TrackingFieldsPanel({ trackingId, fields, initial, onSaved }: {
  trackingId: string;
  fields: TrackingField[];
  initial: Record<string, any> | null | undefined;
  onSaved?: (custom: Record<string, any>) => void;
}) {
  const [values, setValues] = useState<Record<string, any>>(initial ?? {});
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const saved = useRef(JSON.stringify(initial ?? {}));
  const latest = useRef(values);
  latest.current = values;

  // A different deal opened in the same panel: start from its values.
  useEffect(() => { setValues(initial ?? {}); saved.current = JSON.stringify(initial ?? {}); setState("idle"); }, [trackingId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (state !== "saved") return; const t = window.setTimeout(() => setState("idle"), 1600); return () => window.clearTimeout(t); }, [state]);

  const persist = async (next: Record<string, any>) => {
    const snap = JSON.stringify(next);
    if (snap === saved.current) return;
    setState("saving"); setErr(null);
    const e = await saveTrackingCustom(trackingId, next);
    if (e) { setState("error"); setErr(e); return; }
    saved.current = snap; setState("saved"); onSaved?.(next);
  };
  const change = (f: TrackingField, v: any, saveNow: boolean) => {
    const next = { ...latest.current, [f.id]: v };
    setValues(next);
    if (saveNow) persist(next);
  };
  const missing = fields.filter((f) => f.required && isEmptyValue(f, values[f.id])).length;

  return (
    <section className="sl-panel tfp">
      <div className="tfp-head">
        <h3 className="sl-panel-title">Details<span>{fields.length}</span></h3>
        <span className={`tfp-state is-${state}`} aria-live="polite">
          {state === "saving" ? "Saving…" : state === "saved" ? "Saved" : state === "error" ? "Not saved" : missing ? `${missing} required ${missing === 1 ? "field" : "fields"} empty` : ""}
        </span>
      </div>
      {err && <p className="tfp-err">{err}</p>}
      <div className="tfp-list">
        {fields.map((f) => {
          const empty = isEmptyValue(f, values[f.id]);
          const typed = f.type === "text" || f.type === "number";
          return (
            <div key={f.id} className={`tfp-row is-${f.type} ${f.required && empty ? "is-missing" : ""}`}>
              <span className="tfp-k">{f.label}{f.required && <i title="Required">*</i>}</span>
              <span className="tfp-v">
                <FieldInput field={f} value={values[f.id]}
                  onChange={(v) => change(f, v, !typed)}
                  onBlur={typed ? () => persist(latest.current) : undefined} />
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
