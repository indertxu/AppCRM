import { useEffect, useRef, type ReactNode } from "react";
import "./ContractTerms.css";

/* =====================================================================
   Our own "are you sure?" — for closing with unsaved changes (Esc, ×,
   the backdrop, Cancel) and for deleting. Never the browser's confirm.
   ===================================================================== */

export interface ConfirmAction { label: string; tone?: "main" | "danger" | "plain"; onClick: () => void; disabled?: boolean }

export default function ContractConfirm({ icon = "warn", title, body, actions, onCancel }: {
  icon?: "warn" | "trash"; title: string; body?: ReactNode; actions: ConfirmAction[]; onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>(".ctq-btn.is-main, .ctq-btn.is-danger")?.focus(); }, []);
  return (
    <div className="ctq-back" onMouseDown={(e) => { e.stopPropagation(); onCancel(); }}>
      <div className="ctq" role="alertdialog" aria-modal="true" aria-label={title} ref={ref} onMouseDown={(e) => e.stopPropagation()}>
        <span className={`ctq-ico is-${icon}`} aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {icon === "trash" ? <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" /> : <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />}
          </svg>
        </span>
        <b className="ctq-t">{title}</b>
        {body && <p className="ctq-p">{body}</p>}
        <div className="ctq-acts">
          <button type="button" className="ctq-btn" onClick={onCancel}>Keep editing</button>
          <span className="ctq-sp" />
          {actions.map((a) => (
            <button key={a.label} type="button" className={`ctq-btn is-${a.tone ?? "plain"}`} onClick={a.onClick} disabled={a.disabled}>{a.label}</button>
          ))}
        </div>
        <span className="ctq-k">Esc to keep editing</span>
      </div>
    </div>
  );
}

/** Esc on a contract window: closes our confirm first, leaves open pickers alone, else asks to close. */
export function useEscape(onEsc: () => void) {
  const fn = useRef(onEsc);
  fn.current = onEsc;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector(".sel-pop, .dp-pop, .tp-pop, .mi-pop")) return;
      e.preventDefault(); e.stopPropagation();
      fn.current();
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);
}
