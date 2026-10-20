/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState, type ReactNode } from "react";
import FieldInput from "./FieldInput";
import { saveTrackingCustom, isEmptyValue, type TrackingField } from "./trackingFieldsApi";
import "./TrackingFields.css";

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * A deal card that folds: only its header shows until you open it, then the
 * body slides open. The header carries a short summary so the folded card
 * still says something. Used by Contacts, Close probability and Details.
 */
export function FoldPanel({ className = "", title, count, summary, aside, defaultOpen = false, children }: {
  className?: string;
  title: ReactNode;
  count?: number;
  /** One short line shown on the header while the card is folded. */
  summary?: ReactNode;
  /** Header actions outside the fold button (links, menus). */
  aside?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  /** Fully open: menus and pickers inside may overflow the card. */
  const [settled, setSettled] = useState(defaultOpen);
  useEffect(() => {
    if (!open) { setSettled(false); return; }
    if (reducedMotion()) { setSettled(true); return; }
    const t = window.setTimeout(() => setSettled(true), 520); // in case transitionend doesn't fire
    return () => window.clearTimeout(t);
  }, [open]);
  return (
    <section className={`sl-panel sl-fold ${open ? "is-open" : ""} ${settled ? "is-settled" : ""} ${className}`}>
      <div className="sl-fold-head">
        <h3 className="sl-fold-h">
          <button type="button" className="sl-fold-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <span className="sl-panel-title">{title}{count != null && count > 0 && <span>{count}</span>}</span>
            {summary != null && summary !== "" && <span className="sl-fold-sum" aria-hidden={open}>{summary}</span>}
            <svg className="sl-fold-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </button>
        </h3>
        {aside && <div className="sl-fold-aside">{aside}</div>}
      </div>
      <div className="sl-fold-body" inert={!open}
        onTransitionEnd={(e) => { if (e.target === e.currentTarget && open) setSettled(true); }}>
        <div className="sl-fold-in"><div className="sl-fold-pad">{children}</div></div>
      </div>
    </section>
  );
}

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
  const filled = fields.filter((f) => !isEmptyValue(f, values[f.id])).length;

  return (
    <FoldPanel className="tfp" title="Details" count={fields.length}
      summary={missing ? `${missing} required empty` : `${filled} of ${fields.length} filled`}
      aside={state !== "idle" ? (
        <span className={`tfp-state is-${state}`} aria-live="polite">
          {state === "saving" ? "Saving…" : state === "saved" ? "Saved" : "Not saved"}
        </span>
      ) : undefined}>
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
    </FoldPanel>
  );
}
