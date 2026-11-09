/* eslint-disable @typescript-eslint/no-explicit-any */
// Accepting an invitation to client work: what you bill for it (115_invite_bill_mode.sql).
// The organiser either set it ("fixed": shown, to confirm) or left it to you ("they": you choose, their figure suggested).
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../api/supabase";
import type { InviteCard } from "./invitesApi";
import "./InviteBillAsk.css";
import { NumInput } from "../../framework/NumInput";

const hhmm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

export default function InviteBillAsk({ inv, dates = 1, onCancel, onConfirm }: {
  inv: InviteCard;
  /** how many dates one answer covers (a repeating booking) */
  dates?: number;
  onCancel: () => void;
  /** null: keep the organiser's figure */
  onConfirm: (bill: number | null) => void;
}) {
  const they = inv.bill_mode === "they";
  const [unit, setUnit] = useState<{ u: "h" | "d"; step: number }>({ u: "d", step: 0.25 });
  const [val, setVal] = useState<number>(Number(inv.billable) || 0);
  useEffect(() => {
    if (!inv.project_id) return;
    (async () => {
      const { data: pj } = await supabase.from("projects").select("service_id").eq("id", inv.project_id).maybeSingle();
      const sid = (pj as any)?.service_id;
      if (!sid) return;
      const { data: sv } = await supabase.from("services").select("*").eq("id", sid).maybeSingle();
      const u = (sv as any)?.rate_unit === "hour" ? "h" : "d";
      const st = Number((sv as any)?.min_unit) || (u === "h" ? 0.5 : 0.25);
      setUnit({ u, step: st > 0 ? st : 0.25 });
    })().catch(() => {});
  }, [inv.project_id]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } };
    window.addEventListener("keydown", k, true); return () => window.removeEventListener("keydown", k, true);
  }, [onCancel]);
  const word = unit.u === "h" ? (val === 1 ? "hour" : "hours") : (val === 1 ? "day" : "days");
  const round = (n: number) => Math.max(0, Math.round(n / unit.step) * unit.step);
  const when = new Date(`${inv.entry_date}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return createPortal(
    <div className="iba-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="iba" role="dialog" aria-modal="true" aria-label="What you bill for it">
        <span className="iba-ico" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
        </span>
        <h3>{they ? "How much do you bill for it?" : "What you bill for it"}</h3>
        <p className="iba-what"><b>{inv.title || inv.company_name || "The meeting"}</b><span>{dates > 1 ? `${dates} dates, from ${when}` : when} · {hhmm(inv.start_min)}–{hhmm(inv.end_min)} · with {inv.organiser_name}</span></p>
        {they ? (
          <>
            <div className="iba-step">
              <button type="button" onClick={() => setVal((v) => round(v - unit.step))} disabled={val <= 0} aria-label="Less">−</button>
              <label><NumInput type="number" min={0} step={unit.step} value={val} onFocus={(e) => e.target.select()} onChange={(e) => setVal(Math.max(0, Number(e.target.value) || 0))} autoFocus /><span>{word}</span></label>
              <button type="button" onClick={() => setVal((v) => round(v + unit.step))} aria-label="More">+</button>
            </div>
            <p className="iba-note">{Number(inv.billable) > 0 ? <>{inv.organiser_name} suggested <b>{inv.billable}{unit.u}</b>. </> : null}{dates > 1 ? "The same for each date. " : ""}It goes on your calendar and to the client's billing; 0 if it isn't billable.</p>
          </>
        ) : (
          <>
            <div className="iba-fixed"><b>{inv.billable}</b><span>{unit.u === "h" ? (Number(inv.billable) === 1 ? "hour" : "hours") : (Number(inv.billable) === 1 ? "day" : "days")}{dates > 1 ? " each date" : ""}</span></div>
            <p className="iba-note">{inv.organiser_name} set what you bill for it. Ask them if it should be different.</p>
          </>
        )}
        <div className="iba-f">
          <button type="button" className="iba-no" onClick={onCancel}>Back</button>
          <button type="button" className="iba-yes" onClick={() => onConfirm(they ? round(val) : null)}>{dates > 1 ? "Accept all" : "Accept"}{they ? ` · ${round(val)}${unit.u}` : ""}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
