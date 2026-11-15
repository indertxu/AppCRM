/* =====================================================================
   BASE · Settings › Calendar › My calendars — which connected calendars
   your Calendar shows: Google Calendar, Outlook or both, and with several
   accounts a switch per account. Yours only (profiles.prefs.calendarSources,
   src/base/api/calendarSources.ts). Accounts are connected in Integrations.
   Prefix .csrc-
   ===================================================================== */
import { useEffect, useState, type ReactNode } from "react";
import { listAccounts, myOutlookConnection } from "../../api/connectedAccounts";
import { CAL_SOURCES_DEFAULT, loadCalendarSources, saveCalendarSources, type CalendarSources as Sources } from "../../api/calendarSources";
import { BRANDS } from "../settings/brandIcons";
import "./CalendarSources.css";

type Acc = { key: string; provider: "google" | "microsoft"; email: string };

function Logo({ k, color, s = 22 }: { k: "gcal" | "outlook"; color: string; s?: number }) {
  const b = BRANDS[k];
  return (
    <span className="csrc-logo" style={{ ["--c" as string]: b?.hex ?? color, width: s, height: s }}>
      {b && <svg viewBox="0 0 24 24" width={s * 0.56} height={s * 0.56} aria-hidden="true"><path d={b.path} fill="currentColor" /></svg>}
    </span>
  );
}
const G = <Logo k="gcal" color="#4285f4" />;
const M = <Logo k="outlook" color="#0078d4" />;

export default function CalendarSources() {
  const [src, setSrc] = useState<Sources | null>(null);
  const [accs, setAccs] = useState<Acc[] | null>(null);
  const [saved, setSaved] = useState("");
  useEffect(() => {
    loadCalendarSources().then(setSrc).catch(() => setSrc(CAL_SOURCES_DEFAULT));
    Promise.all([listAccounts().catch(() => ({ accounts: [] as any[] })), myOutlookConnection().catch(() => null)]).then(([r, ol]) => {
      const out: Acc[] = [];
      if (ol?.email) out.push({ key: "microsoft:primary", provider: "microsoft", email: ol.email });
      for (const a of r.accounts) {
        if (!a.services?.includes("calendar")) continue;
        if (a.provider === "microsoft" && a.email === ol?.email) continue;
        if (a.provider === "google" || a.provider === "microsoft") out.push({ key: `${a.provider}:${a.id}`, provider: a.provider, email: a.email });
      }
      setAccs(out);
    });
  }, []);
  useEffect(() => { if (!saved) return; const t = setTimeout(() => setSaved(""), 2200); return () => clearTimeout(t); }, [saved]);

  if (!src || !accs) return <div className="csrc-skel"><i /><i /></div>;
  const g = accs.filter((a) => a.provider === "google"), m = accs.filter((a) => a.provider === "microsoft");
  if (!accs.length) return <p className="csrc-none">No calendar connected yet — connect Google Calendar or Outlook in <b>Settings › Integrations</b>, then choose here which ones your Calendar shows.</p>;

  const save = (next: Sources, msg: string) => { setSrc(next); setSaved(msg); void saveCalendarSources(next).catch(() => {}); };
  const gOn = !!g.length && src.google, mOn = !!m.length && src.microsoft;
  const mode = gOn && mOn ? "both" : gOn ? "google" : mOn ? "microsoft" : "none";
  const pick = (k: "google" | "microsoft" | "both") => save({ ...src, google: k !== "microsoft", microsoft: k !== "google" },
    k === "both" ? "Showing Google Calendar and Outlook" : `Showing ${k === "google" ? "Google Calendar" : "Outlook"} only`);
  const toggle = (a: Acc) => {
    const off = src.hidden.includes(a.key);
    save({ ...src, hidden: off ? src.hidden.filter((x) => x !== a.key) : [...src.hidden, a.key] }, `${a.email} ${off ? "shown" : "hidden"}`);
  };
  const opt = (k: "google" | "microsoft" | "both", label: string, sub: string, logos: ReactNode, disabled: boolean) => (
    <button type="button" className={`csrc-opt ${mode === k ? "is-on" : ""}`} disabled={disabled} onClick={() => pick(k)} aria-pressed={mode === k}>
      <span className="csrc-logos">{logos}</span>
      <span className="csrc-opt-t"><b>{label}</b><small>{disabled ? "Not connected" : sub}</small></span>
      <i className="csrc-radio" aria-hidden="true" />
    </button>
  );
  return (
    <div className="csrc">
      <div className="csrc-opts" role="radiogroup" aria-label="Calendars to show">
        {opt("google", "Google Calendar", `${g.length} account${g.length === 1 ? "" : "s"}`, G, !g.length)}
        {opt("microsoft", "Outlook", `${m.length} account${m.length === 1 ? "" : "s"}`, M, !m.length)}
        {opt("both", "Both", "Everything in one calendar", <>{G}{M}</>, !g.length || !m.length)}
      </div>
      {accs.length > 1 && (
        <div className="csrc-accs">
          <span className="csrc-lbl">Accounts</span>
          {accs.map((a) => {
            const on = src[a.provider] && !src.hidden.includes(a.key);
            return (
              <button key={a.key} type="button" className={`csrc-acc ${on ? "is-on" : ""}`} disabled={!src[a.provider]} onClick={() => toggle(a)} aria-pressed={on}
                title={!src[a.provider] ? `Turn ${a.provider === "google" ? "Google Calendar" : "Outlook"} on above first` : on ? "Hide this calendar" : "Show this calendar"}>
                {a.provider === "google" ? G : M}<span>{a.email}</span><i aria-hidden="true" />
              </button>
            );
          })}
        </div>
      )}
      <p className="csrc-note">Only for you — nobody else's calendar changes.{saved && <em> · {saved}</em>}</p>
    </div>
  );
}
