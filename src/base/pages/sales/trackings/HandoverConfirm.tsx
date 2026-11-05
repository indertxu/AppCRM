import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import "./Handover.css";

/**
 * Double confirmation before a deal is handed over.
 *  1. What happens: the deal leaves the role, who takes it, who keeps a frozen copy.
 *  2. "Are you sure?" — the move only happens after the second click.
 * Cancel (or Esc, or clicking outside) leaves the deal where it was.
 */
export default function HandoverConfirm({ deal, roleName, roleColor, fromNames, toName, lastPhase, toPhase, onConfirm, onCancel }: {
  deal: string;
  roleName: string;
  roleColor?: string | null;
  fromNames: string[];
  toName: string;
  lastPhase: string;
  toPhase: string;
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) { e.stopPropagation(); onCancel(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel, busy]);
  const go = async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } };
  const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

  return createPortal(
    <div className="hov-backdrop" onMouseDown={() => !busy && onCancel()}>
      <div className={`hov is-step${step}`} role="alertdialog" aria-modal="true" aria-label="Hand over this deal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="hov-steps" aria-hidden="true"><i className="is-on" /><i className={step === 2 ? "is-on" : ""} /></div>
        <span className="hov-eyebrow">Handover · step {step} of 2</span>
        <h2 className="hov-title">{step === 1 ? <>“{deal}” moves on to <b>{toPhase}</b></> : "Confirm the handover?"}</h2>

        {step === 1 ? (
          <>
            <div className="hov-flow">
              <div className="hov-side">
                <span className="hov-role" style={{ ["--c" as string]: roleColor || "#1fb98a" }}>{roleName}</span>
                <div className="hov-people">
                  {fromNames.length ? fromNames.map((n) => <span key={n} className="hov-av" title={n}>{initials(n)}</span>) : <span className="hov-none">—</span>}
                </div>
                <small>{fromNames.length ? fromNames.join(", ") : "Nobody from the role is on it"}</small>
              </div>
              <span className="hov-arrow" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12h15M13 6l6 6-6 6" /></svg>
              </span>
              <div className="hov-side is-to">
                <span className="hov-role is-new">New owner</span>
                <div className="hov-people"><span className="hov-av is-big">{initials(toName)}</span></div>
                <small><b>{toName}</b></small>
              </div>
            </div>
            <ul className="hov-list">
              <li><b>{toName}</b> becomes the owner of the deal.</li>
              <li><b>{roleName}</b> only sees deals up to <b>{lastPhase}</b>, so from now on it no longer sees this one.</li>
              {fromNames.length > 0 && <li><b>{fromNames.join(", ")}</b> {fromNames.length === 1 ? "stays" : "stay"} on the deal but only {fromNames.length === 1 ? "sees" : "see"} it as it is right now — nothing added after the handover.</li>}
            </ul>
            <div className="hov-actions">
              <button className="hov-ghost" onClick={onCancel}>Cancel</button>
              <button className="hov-go" onClick={() => setStep(2)} autoFocus>Continue</button>
            </div>
          </>
        ) : (
          <>
            <p className="hov-sure">
              The deal goes to <b>{toName}</b> and leaves <b>{roleName}</b>. Moving it back later doesn't return it automatically — a sales manager would have to reassign it.
            </p>
            <div className="hov-actions">
              <button className="hov-ghost" onClick={() => setStep(1)} disabled={busy}>Back</button>
              <button className="hov-go is-final" onClick={go} disabled={busy} autoFocus>{busy ? "Handing over…" : "Yes, hand it over"}</button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
