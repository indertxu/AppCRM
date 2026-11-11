import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import Select from "../../../framework/Select";

/* =====================================================================
   Who a report is shared with (126_report_sharing.sql). A report has one
   owner, who shares it with the whole team (view), or with people — to
   view it, or to view and change it — and can hand it over to someone.
   Everyone else sees the list, read-only.
   ===================================================================== */

export interface SharePerson { id: string; name: string; email?: string; former?: boolean }
export interface ShareState { shared: boolean; sharedWith: string[]; editors: string[] }

const I = {
  people: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  me: "M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2",
  x: "M6 6l12 12M18 6L6 18", crown: "M3 18h18M4 8l4 4 4-7 4 7 4-4-2 10H6z", lock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4",
  team: "M3 21h18M5 21V8l7-5 7 5v13M9 13h6M9 17h6",
};
const Ico = ({ d, w = 2 }: { d: string; w?: number }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
const hue = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const Av = ({ name, size = 30 }: { name: string; size?: number }) => (
  <span className="rs-av" style={{ "--h": hue(name), width: size, height: size, fontSize: Math.round(size * 0.38) } as CSSProperties}>{initials(name)}</span>
);

export default function ReportShare({ value, onChange, ownerId, me, people, canManage, missing, isNew }: {
  value: ShareState;
  onChange: (next: ShareState, newOwner?: string) => void;
  ownerId: string | null;
  me: string | null;
  people: SharePerson[];
  /** The owner (or a report not saved yet): may change who sees it. */
  canManage: boolean;
  /** 126_report_sharing.sql isn't in the database yet: only the whole-team switch works. */
  missing?: boolean;
  isNew?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState("");
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({});
  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const w = Math.min(400, window.innerWidth - 16);
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
    const below = window.innerHeight - r.bottom - 12;
    const next: CSSProperties = below >= 360 || below >= r.top ? { left, top: r.bottom + 6, width: w, maxHeight: Math.max(240, below) } : { left, bottom: window.innerHeight - r.top + 6, width: w, maxHeight: Math.max(240, r.top - 12) };
    setPos((p) => (JSON.stringify(p) === JSON.stringify(next) ? p : next));
  };
  useLayoutEffect(() => { if (open) place(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Element;
      if (btn.current?.contains(t) || pop.current?.contains(t) || t.closest?.(".sel-pop, .sel-layer, [role=listbox]")) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector(".sel-pop, [role=listbox]")) setOpen(false); };
    const re = () => place();
    document.addEventListener("mousedown", down); window.addEventListener("keydown", key); window.addEventListener("resize", re); window.addEventListener("scroll", re, true);
    return () => { document.removeEventListener("mousedown", down); window.removeEventListener("keydown", key); window.removeEventListener("resize", re); window.removeEventListener("scroll", re, true); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const byId = new Map(people.map((p) => [p.id, p]));
  const nameOf = (id: string) => byId.get(id)?.name ?? "Someone";
  const owner = ownerId ?? me;
  const members = [...new Set([...value.editors, ...value.sharedWith])].filter((id) => id !== owner);
  const roleOf = (id: string) => (value.editors.includes(id) ? "edit" : "view");
  const setRole = (id: string, r: string) => {
    if (r === "remove") { onChange({ ...value, sharedWith: value.sharedWith.filter((x) => x !== id), editors: value.editors.filter((x) => x !== id) }); return; }
    if (r === "owner") {
      if (!window.confirm(`Make ${nameOf(id)} the owner of this report? You keep it as someone who can change it, but only ${nameOf(id).split(" ")[0]} will manage who sees it.`)) return;
      const editors = [...value.editors.filter((x) => x !== id), ...(me ? [me] : [])];
      onChange({ ...value, sharedWith: value.sharedWith.filter((x) => x !== id && x !== me), editors: [...new Set(editors)] }, id);
      setOpen(false);
      return;
    }
    const sharedWith = r === "view" ? [...new Set([...value.sharedWith, id])] : value.sharedWith.filter((x) => x !== id);
    const editors = r === "edit" ? [...new Set([...value.editors, id])] : value.editors.filter((x) => x !== id);
    onChange({ ...value, sharedWith, editors });
  };
  const add = (id: string) => { setPick(""); if (!id) return; onChange({ ...value, sharedWith: [...new Set([...value.sharedWith, id])] }); };
  const candidates = people.filter((p) => p.id !== owner && !members.includes(p.id) && !p.former);

  const label = members.length ? `${members.length} ${members.length === 1 ? "person" : "people"}${value.shared ? " · team" : ""}` : value.shared ? "Team" : "Only me";
  const lit = value.shared || members.length > 0;

  return (
    <>
      <button ref={btn} type="button" className={`rp-share rs-trig ${lit ? "is-on" : ""} ${open ? "is-open" : ""}`} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="dialog"
        title={canManage ? "Who sees this report" : "Who this report is shared with"}>
        {members.length ? (
          <span className="rs-stack">{members.slice(0, 3).map((id) => <Av key={id} name={nameOf(id)} size={20} />)}</span>
        ) : <Ico d={value.shared ? I.people : I.me} />}
        {label}
      </button>
      {open && createPortal(
        <div ref={pop} className="rs-pop" role="dialog" aria-label="Share the report" style={pos}>
          <header className="rs-h">
            <b>Share this report</b>
            <em>{canManage ? (isNew ? "Saved with the report" : "Changes apply at once") : "Only its owner changes this"}</em>
          </header>

          <div className="rs-row is-owner">
            <Av name={owner ? (owner === me ? nameOf(owner) || "You" : nameOf(owner)) : "You"} />
            <span className="rs-who"><b>{owner && owner !== me ? nameOf(owner) : "You"}</b><em>{owner && owner !== me ? byId.get(owner)?.email ?? "" : "The owner"}</em></span>
            <span className="rs-tag is-owner"><Ico d={I.crown} />Owner</span>
          </div>

          <button type="button" className={`rs-team ${value.shared ? "is-on" : ""}`} disabled={!canManage} onClick={() => onChange({ ...value, shared: !value.shared })} aria-pressed={value.shared}>
            <span className="rs-team-ico"><Ico d={I.team} /></span>
            <span className="rs-who"><b>Everyone in the team</b><em>{value.shared ? "Can view it" : "Off: only the people below"}</em></span>
            <span className={`rs-sw ${value.shared ? "is-on" : ""}`} aria-hidden="true"><i /></span>
          </button>

          {missing ? (
            <p className="rs-miss"><Ico d={I.lock} />Sharing with people needs <b>126_report_sharing.sql</b> in Supabase.</p>
          ) : (
            <>
              <div className="rs-sec-h"><span>People</span>{members.length > 0 && <em>{members.length}</em>}</div>
              {canManage && (
                <div className="rs-add">
                  <Select value={pick} onChange={add} searchable placeholder="Add someone…" aria-label="Add someone"
                    options={candidates.map((p) => ({ value: p.id, label: p.name, hint: p.email || undefined }))} />
                </div>
              )}
              {members.length ? (
                <div className="rs-list">
                  {members.map((id) => (
                    <div className="rs-row" key={id}>
                      <Av name={nameOf(id)} />
                      <span className="rs-who"><b>{nameOf(id)}{id === me ? " (you)" : ""}</b><em>{byId.get(id)?.email ?? ""}</em></span>
                      {canManage ? (
                        <span className="rs-role">
                          <Select size="sm" value={roleOf(id)} onChange={(r) => setRole(id, r)} aria-label={`What ${nameOf(id)} can do`}
                            options={[
                              { value: "view", label: "Can view" },
                              { value: "edit", label: "Can edit", hint: "Changes it in place" },
                              ...(!isNew && owner === me ? [{ value: "owner", label: "Make owner", hint: "Hands it over" }] : []),
                              { value: "remove", label: "Remove", hint: "Stops seeing it" },
                            ]} />
                        </span>
                      ) : <span className={`rs-tag ${roleOf(id) === "edit" ? "is-edit" : ""}`}>{roleOf(id) === "edit" ? "Can edit" : "Can view"}</span>}
                    </div>
                  ))}
                </div>
              ) : <p className="rs-none">{canManage ? "Nobody yet — add who should see it. They get a notification." : "Not shared with anyone in particular."}</p>}
            </>
          )}
          <p className="rs-foot">Each person sees only the records they're allowed to see. People who can edit change it for everyone; the rest save their changes as their own copy.</p>
        </div>,
        document.body,
      )}
    </>
  );
}
