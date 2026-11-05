import type { OrbitKind } from "./orbitTypes";
import "./Orbit.css";

const ICON: Record<OrbitKind, string> = {
  contact: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8",
  company: "M3 21h18M5 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16M16 9h3a2 2 0 0 1 2 2v10M9 7h3M9 11h3M9 15h3",
};

/**
 * BASE · the header of a new record's panel: what you are creating, Contact or Company,
 * one click to change it (the panel keeps what both kinds share: e-mail, phone, address, notes).
 */
export default function KindSwitch({ on, onPick, swapped }: { on: OrbitKind; onPick: (k: OrbitKind) => void; swapped?: boolean }) {
  return (
    <div className="oks-wrap">
      <span className="oks-lbl">New</span>
      <div className={`oks is-${on}${swapped ? " is-swap" : ""}`} role="radiogroup" aria-label="What you are creating">
        {(["contact", "company"] as OrbitKind[]).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={on === k} className={on === k ? "is-on" : ""}
            onClick={() => { if (k !== on) onPick(k); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICON[k]} /></svg>
            {k === "contact" ? "Contact" : "Company"}
          </button>
        ))}
      </div>
    </div>
  );
}
