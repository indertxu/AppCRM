/* =====================================================================
   BASE · Settings › Calendar › Who sees whom — two lists:
     Only their own calendar   ·   Sees other people's calendars
   Move people from one to the other (the arrow, or drag them across).
   For those who see others, choose whose: everyone, their department, or
   chosen people — and whether they read the entries or only busy times.
   Saved as each person's own rule in page_data_scopes "calendar_view"
   (CalViewRules.users; see = "picked" + ids for chosen people), the same
   rules the Calendar reads. Rules by security role / department stay
   below in "By role and department". Bosses and superadmins see everything.
   ===================================================================== */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { supabase } from "../../../components/api/supabase";
import Select from "../../framework/Select";
import {
  loadDepartments, loadCalendarView, saveCalendarView, calendarViewFor, canSeeCalendar, usePageAccess, levelBase, useSecurityLevels,
  type CalViewRules, type CalViewRule, type CalSee, type CalDetail, type Department,
} from "../../framework/pageAccess";
import { CalendarVisibility } from "../settings/PageAccessModal";
import "./CalendarAccess.css";

interface P { id: string; name: string; role: string; department: string | null; full: boolean }
const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
const Ico = ({ d, s = 15, w = 2 }: { d: string; s?: number; w?: number }) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const D = {
  lock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  right: "M5 12h14M13 6l6 6-6 6",
  left: "M19 12H5M11 6l-6 6 6 6",
  x: "M18 6L6 18M6 6l12 12",
  check: "M5 12.5l4.5 4.5L19 7.5",
  down: "M6 9l6 6 6-6",
  crown: "M3 18h18M4 8l4 4 4-7 4 7 4-4-2 10H6z",
  warn: "M12 3 2 20h20zM12 10v4M12 17h.01",
};
const SEE: { v: CalSee; label: string }[] = [
  { v: "all", label: "Everyone" },
  { v: "department", label: "Their department" },
  { v: "picked", label: "Chosen people" },
];
const DETAIL: { v: CalDetail; label: string; hint: string }[] = [
  { v: "full", label: "Read entries", hint: "What each entry is, the client and the notes" },
  { v: "busy", label: "Only busy times", hint: "Enough to find a free slot" },
];

export default function CalendarAccess() {
  const { level, isSuper } = usePageAccess();
  const canEdit = isSuper || levelBase(level) === "boss";
  const levels = useSecurityLevels();
  const [rules, setRules] = useState<CalViewRules | null>(null);
  const [missing, setMissing] = useState(false);
  const [depts, setDepts] = useState<Department[]>([]);
  const [people, setPeople] = useState<P[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [drag, setDrag] = useState<{ id: string; from: "own" | "others" } | null>(null);
  const [over, setOver] = useState<"own" | "others" | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [adv, setAdv] = useState(false);
  const savedT = useRef(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [r, ds, profs] = await Promise.all([loadCalendarView(), loadDepartments(true), supabase.from("profiles").select("*").range(0, 99999)]);
      if (!alive) return;
      setRules(r.rules); setMissing(r.missing); setDepts(ds);
      setPeople(((profs.data ?? []) as any[]).filter((p) => p.active !== false).map((p) => ({
        id: p.id, name: [p.first_name, p.last_name].filter(Boolean).join(" ") || p.full_name || p.email || "—",
        role: String(p.security_level ?? p.role ?? "").toLowerCase(), department: p.department ?? null,
        full: p.is_superadmin === true || String(p.role ?? "").toLowerCase() === "boss" || levelBase(String(p.security_level ?? "")) === "boss",
      })).sort((a, b) => a.name.localeCompare(b.name)));
    })();
    return () => { alive = false; window.clearTimeout(savedT.current); };
  }, [adv]);

  const deptOf = (k: string | null) => depts.find((d) => d.key === k);
  const roleName = (k: string) => levels.find((l) => l.key === k)?.name ?? (k ? k.charAt(0).toUpperCase() + k.slice(1) : "");
  const ruleOf = (p: P): CalViewRule => calendarViewFor(rules ?? { everyone: null, roles: {}, depts: {}, users: {} }, { userId: p.id, department: p.department, role: p.role, isFull: p.full });
  const bosses = people.filter((p) => p.full);
  const staff = people.filter((p) => !p.full);
  const t = q.trim().toLowerCase();
  const match = (p: P) => !t || p.name.toLowerCase().includes(t) || (deptOf(p.department)?.name ?? "").toLowerCase().includes(t);
  const own = useMemo(() => staff.filter((p) => ruleOf(p).see === "own"), [staff, rules]); // eslint-disable-line react-hooks/exhaustive-deps
  const others = useMemo(() => staff.filter((p) => ruleOf(p).see !== "own"), [staff, rules]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!rules) return <div className="cax"><div className="cax-skel" /><div className="cax-skel" /></div>;

  const commit = async (next: CalViewRules) => {
    setRules(next); setState("saving"); setErr(null);
    const e = await saveCalendarView(next);
    if (e) { setState("error"); setErr(e); return; }
    setState("saved");
    window.clearTimeout(savedT.current);
    savedT.current = window.setTimeout(() => setState("idle"), 1800);
  };
  const setUser = (id: string, v: CalViewRule | null) => {
    const users = { ...rules.users };
    if (v) users[id] = v; else delete users[id];
    void commit({ ...rules, users });
  };
  const toOwn = (p: P) => { setUser(p.id, { see: "own", detail: ruleOf(p).detail }); if (open === p.id) setOpen(null); };
  const toOthers = (p: P) => {
    const was = ruleOf(p);
    // what their role / department would give them, if that lets them see others; else start with chosen people
    const { users: _u, ...rest } = rules; void _u;
    const inherit = calendarViewFor({ ...rest, users: {} }, { userId: p.id, department: p.department, role: p.role, isFull: false });
    setUser(p.id, inherit.see !== "own" ? inherit : { see: p.department ? "department" : "picked", detail: was.detail === "busy" ? "full" : was.detail, ids: [] });
    setOpen(p.id);
  };
  /** Whose calendars someone sees, in a few words. */
  const sees = (p: P, r: CalViewRule) => {
    if (r.see === "all") return "Everyone's calendar";
    if (r.see === "department") return p.department ? `${deptOf(p.department)?.name ?? "Their department"}` : "Their department (none set)";
    if (r.see === "team") return `${deptOf(p.department)?.name ?? "Their department"}, not the managers`;
    const n = (r.ids ?? []).filter((id) => id !== p.id).length;
    return n === 0 ? "Nobody chosen yet" : `${n} ${n === 1 ? "person" : "people"}`;
  };
  const viaWhat = (p: P) => (rules.users[p.id] ? null : rules.roles[p.role] ? `via ${roleName(p.role)}` : p.department && rules.depts[p.department] ? `via ${deptOf(p.department)?.name ?? "department"}` : rules.everyone ? "via everyone" : "default");

  const onDragStart = (p: P, from: "own" | "others") => (e: DragEvent) => {
    if (!canEdit) { e.preventDefault(); return; }
    e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", p.id);
    setDrag({ id: p.id, from });
  };
  const dropOn = (to: "own" | "others") => ({
    onDragOver: (e: DragEvent) => { if (drag && drag.from !== to) { e.preventDefault(); setOver(to); } },
    onDragLeave: (e: DragEvent) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver(null); },
    onDrop: (e: DragEvent) => {
      e.preventDefault(); setOver(null);
      const p = drag && people.find((x) => x.id === drag.id);
      setDrag(null);
      if (!p || drag!.from === to) return;
      if (to === "own") toOwn(p); else toOthers(p);
    },
  });

  const Av = ({ p, s = 34 }: { p: P; s?: number }) => (
    <span className="cax-av" style={{ width: s, height: s, fontSize: s * 0.36, "--c": deptOf(p.department)?.color ?? "#9fb5ab" } as CSSProperties}>{initials(p.name)}</span>
  );
  const sub = (p: P) => { const d = deptOf(p.department)?.name ?? "No department", r = roleName(p.role); return r && r.toLowerCase() !== d.toLowerCase() ? `${d} · ${r}` : d; };

  const editor = (p: P, r: CalViewRule) => {
    const ids = (r.ids ?? []).filter((id) => id !== p.id);
    const chosen = ids.map((id) => people.find((x) => x.id === id)).filter(Boolean) as P[];
    const addable = people.filter((o) => o.id !== p.id && !ids.includes(o.id));
    const seen = people.filter((o) => o.id !== p.id && canSeeCalendar(r, { userId: p.id, department: p.department }, o));
    const set = (patch: Partial<CalViewRule>) => setUser(p.id, { ...r, ...patch, ...(patch.see && patch.see !== "picked" ? { ids: r.ids } : {}) });
    return (
      <div className="cax-ed" onClick={(e) => e.stopPropagation()}>
        <div className="cax-ed-l">Whose calendars</div>
        <div className="cax-seg" role="radiogroup" aria-label="Whose calendars">
          {SEE.map((o) => (
            <button key={o.v} type="button" role="radio" aria-checked={r.see === o.v} className={r.see === o.v || (o.v === "department" && r.see === "team") ? "is-on" : ""} disabled={!canEdit}
              onClick={() => set(o.v === "picked" ? { see: "picked", ids: r.ids ?? [] } : { see: o.v })}>{o.label}</button>
          ))}
        </div>
        {r.see === "picked" && (
          <div className="cax-chips">
            {chosen.map((o) => (
              <span key={o.id} className="cax-chip"><Av p={o} s={22} />{o.name}
                {canEdit && <button type="button" onClick={() => set({ ids: ids.filter((x) => x !== o.id) })} aria-label={`Remove ${o.name}`}><Ico d={D.x} s={12} w={2.4} /></button>}
              </span>
            ))}
            {canEdit && addable.length > 0 && (
              <div className="cax-add">
                <Select value="" placeholder="+ Add a calendar" searchable onChange={(id) => id && set({ ids: [...ids, id] })}
                  options={addable.map((o) => ({ value: o.id, label: o.name, hint: deptOf(o.department)?.name ?? (o.full ? "Boss" : "No department") }))} />
              </div>
            )}
            {chosen.length === 0 && <span className="cax-warn"><Ico d={D.warn} s={13} />Pick whose calendars {p.name.split(" ")[0]} can open.</span>}
          </div>
        )}
        {r.see !== "picked" && (
          <div className="cax-seen">
            <div className="cax-avs">{seen.slice(0, 14).map((o) => <Av key={o.id} p={o} s={24} />)}{seen.length > 14 && <em>+{seen.length - 14}</em>}</div>
            <small>{seen.length} {seen.length === 1 ? "calendar" : "calendars"}{r.see === "department" && !p.department ? " — give them a department in Organization" : ""}</small>
          </div>
        )}
        <div className="cax-ed-l">How much they see</div>
        <div className="cax-seg" role="radiogroup" aria-label="How much they see">
          {DETAIL.map((o) => (
            <button key={o.v} type="button" role="radio" aria-checked={r.detail === o.v || (o.v === "full" && r.detail === "department")} title={o.hint}
              className={r.detail === o.v || (o.v === "full" && r.detail === "department") ? "is-on" : ""} disabled={!canEdit} onClick={() => set({ detail: o.v })}>
              <Ico d={o.v === "full" ? D.eye : D.lock} s={13} />{o.label}
            </button>
          ))}
        </div>
        {canEdit && rules.users[p.id] && (
          <button type="button" className="cax-reset" onClick={() => { setUser(p.id, null); setOpen(null); }}>Follow their role again</button>
        )}
      </div>
    );
  };

  return (
    <div className={`cax ${canEdit ? "" : "is-ro"} ${drag ? "is-dragging" : ""}`}>
      <div className="cax-lead">
        <p>Who only sees their own calendar, and who can open other people's — and whose. Move someone across with the arrow or drag them. <b>Bosses</b> and superadmins always see everything.</p>
        <span className={`cax-state is-${state}`} aria-live="polite">{state === "saving" ? "Saving…" : state === "saved" ? <><Ico d={D.check} s={13} w={2.6} />Saved</> : state === "error" ? "Not saved" : ""}</span>
      </div>
      {missing && <p className="cax-err"><Ico d={D.warn} s={14} />Run <b>63_page_data_scopes.sql</b> in Supabase to save these settings.</p>}
      {err && !missing && <p className="cax-err"><Ico d={D.warn} s={14} />{err}</p>}
      {!canEdit && <p className="cax-note">Only a Boss or a superadmin can change this.</p>}

      <div className="cax-tools">
        <label className="cax-search"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3" /></svg>
          <input value={q} placeholder="Find someone…" onChange={(e) => setQ(e.target.value)} /></label>
        {bosses.length > 0 && (
          <span className="cax-boss" title={bosses.map((b) => b.name).join(", ")}><Ico d={D.crown} s={14} />
            <span className="cax-avs">{bosses.slice(0, 5).map((b) => <Av key={b.id} p={b} s={22} />)}</span>
            {bosses.length} {bosses.length === 1 ? "sees" : "see"} everything
          </span>
        )}
      </div>

      <div className="cax-cols">
        <section className={`cax-col is-own ${over === "own" ? "is-over" : ""}`} {...dropOn("own")}>
          <header><span className="cax-col-ico"><Ico d={D.lock} s={16} /></span><div><b>Only their own calendar</b><small>Nobody else's entries or busy times</small></div><em>{own.length}</em></header>
          <div className="cax-list">
            {own.filter(match).length === 0 && <p className="cax-empty">{t ? "Nobody matches." : canEdit ? "Nobody here — drag someone in to keep them to their own calendar." : "Nobody here."}</p>}
            {own.filter(match).map((p, i) => (
              <div key={p.id} className={`cax-row ${drag?.id === p.id ? "is-drag" : ""}`} style={{ "--i": Math.min(i, 12) } as CSSProperties}
                draggable={canEdit} onDragStart={onDragStart(p, "own")} onDragEnd={() => { setDrag(null); setOver(null); }}>
                <Av p={p} />
                <span className="cax-row-t"><b>{p.name}</b><small>{sub(p)}{viaWhat(p) && viaWhat(p) !== "default" ? ` · ${viaWhat(p)}` : ""}</small></span>
                {canEdit && <button type="button" className="cax-mv" onClick={() => toOthers(p)} title="Let them see other people's calendars" aria-label={`Let ${p.name} see other calendars`}><Ico d={D.right} /></button>}
              </div>
            ))}
          </div>
        </section>

        <section className={`cax-col is-others ${over === "others" ? "is-over" : ""}`} {...dropOn("others")}>
          <header><span className="cax-col-ico"><Ico d={D.eye} s={16} /></span><div><b>Sees other people's calendars</b><small>Choose whose, and how much they see</small></div><em>{others.length}</em></header>
          <div className="cax-list">
            {others.filter(match).length === 0 && <p className="cax-empty">{t ? "Nobody matches." : "Nobody sees other calendars yet."}</p>}
            {others.filter(match).map((p, i) => {
              const r = ruleOf(p);
              const isOpen = open === p.id;
              const empty = r.see === "picked" && !(r.ids ?? []).some((id) => id !== p.id);
              return (
                <div key={p.id} className={`cax-row is-x ${isOpen ? "is-open" : ""} ${drag?.id === p.id ? "is-drag" : ""}`} style={{ "--i": Math.min(i, 12) } as CSSProperties}
                  draggable={canEdit && !isOpen} onDragStart={onDragStart(p, "others")} onDragEnd={() => { setDrag(null); setOver(null); }}>
                  <div className="cax-row-h" onClick={() => setOpen(isOpen ? null : p.id)} role="button" tabIndex={0} aria-expanded={isOpen}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(isOpen ? null : p.id); } }}>
                    <Av p={p} />
                    <span className="cax-row-t"><b>{p.name}</b>
                      <small className={empty ? "is-warn" : ""}>{sees(p, r)} · {r.detail === "busy" ? "busy times" : r.detail === "department" ? "reads their department" : "reads entries"}{viaWhat(p) && viaWhat(p) !== "default" ? ` · ${viaWhat(p)}` : ""}</small>
                    </span>
{canEdit && <button type="button" className="cax-mv is-back" onClick={(e) => { e.stopPropagation(); toOwn(p); }} title="Only their own calendar" aria-label={`Keep ${p.name} to their own calendar`}><Ico d={D.left} /></button>}
                    <span className="cax-chev"><Ico d={D.down} s={15} /></span>
                  </div>
                  {isOpen && editor(p, r)}
                </div>
              );
            })}
          </div>
        </section>
      </div>

      <button type="button" className={`cax-adv ${adv ? "is-open" : ""}`} onClick={() => setAdv((v) => !v)}>
        <Ico d={D.down} s={14} />By security role and department <small>defaults for people without their own setting</small>
      </button>
      {adv && <div className="cax-adv-body"><CalendarVisibility /></div>}
    </div>
  );
}
