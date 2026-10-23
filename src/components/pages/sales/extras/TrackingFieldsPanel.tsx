/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import FieldInput from "./FieldInput";
import { saveTrackingCustom, isEmptyValue, type TrackingField } from "./trackingFieldsApi";
import "./TrackingFields.css";

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * A deal card that folds: only its header shows until you open it, then the
 * body slides open. The header carries a short summary so the folded card
 * still says something. Used by Contacts, Close probability and Details.
 */
/** Icons for the folded card headers (SVG path data, 24x24, stroked). */
export const FOLD_ICON = {
  proposals: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h4",
  contacts: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  probability: "M18 20V10M12 20V4M6 20v-6",
  details: "M4 6h16M4 12h16M4 18h10",
  calculator: "M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM8 6h8M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01M8 19h4",
};

export function FoldPanel({ className = "", title, count, summary, aside, defaultOpen = false, icon, tone, openSignal, children }: {
  className?: string;
  /** Bump it to open the card from outside (e.g. "New" in the header of a folded card). */
  openSignal?: number;
  /** SVG path data for the header's icon chip (see FOLD_ICON). */
  icon?: string;
  /** Accent of the card: icon chip, count and hover. */
  tone?: string;
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
  useEffect(() => { if (openSignal) setOpen(true); }, [openSignal]);
  /** Fully open: menus and pickers inside may overflow the card. */
  const [settled, setSettled] = useState(defaultOpen);
  useEffect(() => {
    if (!open) { setSettled(false); return; }
    if (reducedMotion()) { setSettled(true); return; }
    const t = window.setTimeout(() => setSettled(true), 520); // in case transitionend doesn't fire
    return () => window.clearTimeout(t);
  }, [open]);
  return (
    <section className={`sl-panel sl-fold ${icon ? "has-ico" : ""} ${open ? "is-open" : ""} ${settled ? "is-settled" : ""} ${className}`}
      style={tone ? ({ "--fold-tone": tone } as CSSProperties) : undefined}>
      <div className="sl-fold-head">
        <h3 className="sl-fold-h">
          <button type="button" className="sl-fold-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {icon && (
              <span className="sl-fold-ico" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={icon} /></svg>
              </span>
            )}
            <span className="sl-panel-title">{title}{count != null && count > 0 && <span>{count}</span>}</span>
            {summary != null && summary !== "" && <span className="sl-fold-sum" aria-hidden={open}>{summary}</span>}
            <span className="sl-fold-chevw" aria-hidden="true"><svg className="sl-fold-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></span>
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
    <FoldPanel className="tfp" title="Details" count={fields.length} icon={FOLD_ICON.details} tone="#4a6b5e"
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
