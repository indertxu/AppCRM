/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../api/supabase";
import { LEVELS } from "./NewUserModal";
import { DEPARTMENTS } from "./Organization";
import {
  PAGES, PANELS, panelsOf, panelDef, isPanelKey, loadPageRules, savePageRules, resolvePage, resolveAny, resolveAllPages,
  isFullAccess, pageRuleKey, usePageAccess, SECURITY_LEVEL_EVENT,
  type PageKey, type PageMap, type PageRules, type PageSubject, type PageSourceKind, type AccessPerson, type Level, type PanelDef,
} from "../../framework/pageAccess";
import "./PageAccessModal.css";

/* ─────────────── page icons (same as the side menu) ─────────────── */
const svg = (children: ReactNode, w = 1.9) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round">{children}</svg>;
const PAGE_ICON: Record<PageKey, ReactNode> = {
  home: svg(<><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" /></>),
  calendar: svg(<><rect x="3" y="4.5" width="18" height="16" rx="3" /><path d="M3 9h18M8 2.5v4M16 2.5v4" /></>),
  contacts: svg(<><rect x="4" y="3" width="16" height="18" rx="2" /><circle cx="12" cy="10" r="2.6" /><path d="M8 17a4 4 0 0 1 8 0M4 7h2M4 12h1.5M4 17h2" /></>),
  companies: svg(<><rect x="4" y="3" width="10" height="18" rx="1.5" /><path d="M14 8h6v13H4M7.5 7h3M7.5 11h3M7.5 15h3" /></>),
  clients: svg(<><circle cx="9" cy="8" r="3.2" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" /><circle cx="17.5" cy="9" r="2.4" /><path d="M16 14.2a4.8 4.8 0 0 1 4.5 4.8" /></>),
  projects: svg(<><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M8 13h8M8 16h5" /></>),
  sales: svg(<><path d="M3 3v18h18" /><path d="M7 14l3-3 3 2 5-6" /></>),
  management: svg(<><rect x="3" y="3" width="8" height="7" rx="1.6" /><rect x="13" y="3" width="8" height="4.5" rx="1.6" /><rect x="13" y="10.5" width="8" height="10.5" rx="1.6" /><rect x="3" y="13" width="8" height="8" rx="1.6" /></>),
  settings: svg(<><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></>),
};
const LOCK = svg(<><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>);
const CHECK = svg(<path d="M5 12.5l4.5 4.5L19 7.5" />, 2.6);
const DASH = svg(<path d="M7 12h10" />, 2.6);

const levelLabel = (id: string | null | undefined) => LEVELS.find((l: any) => l.id === id)?.label ?? (id ? id.split("_").map((w, i) => (i ? w : w[0].toUpperCase() + w.slice(1))).join(" ") : "No security role");
const deptLabel = (k: string | null | undefined) => (DEPARTMENTS as readonly any[]).find((d) => d.key === k)?.label ?? k ?? "No department";
const deptColor = (k: string | null | undefined) => (DEPARTMENTS as readonly any[]).find((d) => d.key === k)?.color ?? "#9fb5ab";
const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
const SOURCE_LABEL: Record<PageSourceKind, string> = { boss: "Full access", locked: "Always open", user: "Person", role: "Security role", dept: "Department", everyone: "Everyone", default: "Default" };
/** Words for a level: hidden / open for pages and two-way panels; hidden / own / all for the rest. */
const isGraded = (key: string) => (panelDef(key)?.levels.length ?? 2) > 2;
const levelText = (key: string, l: Level) => (l === "none" ? "Hidden" : isGraded(key) ? (l === "own" ? "Own data" : "All data") : "Open");
/** What's stored for a choice: pages keep true/false, panels a level. */
const stored = (key: string, l: Level): boolean | Level => (isPanelKey(key) ? l : l !== "none");
const asLv = (v: boolean | Level | undefined): Level | undefined => (v === undefined ? undefined : v === true ? "all" : v === false ? "none" : v);
const ALL_KEYS = [...PAGES.map((p) => p.key as string), ...PANELS.filter((p) => !p.locked).map((p) => p.key)];

const CHEVRON = svg(<path d="M9 6l6 6-6 6" />, 2.2);
const GROUPS_KEY = "next.pageAccess.groups";
const TOUR_KEY = "next.pageAccess.tourSeen";
const readLS = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const writeLS = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

/* ─────────────── quick tutorial ─────────────── */
const miniChoice = (opts: string[], on: number, inherit?: string) => (
  <div className={`pas-choice ${opts.length > 2 ? "is-4" : ""} pas-tour-choice`} aria-hidden="true">
    <button className={`is-inherit ${on === 0 ? "is-on" : ""}`} tabIndex={-1}><span>Inherit</span><small>{inherit ?? "Open"}</small></button>
    {opts.map((o, i) => <button key={o} tabIndex={-1} className={`${o === "Hidden" ? "is-neg" : o === "Own" ? "is-own" : ""} ${on === i + 1 ? "is-on" : ""}`}><span>{o}</span></button>)}
  </div>
);
const TOUR: { title: string; body: ReactNode; art: ReactNode }[] = [
  {
    title: "Pick who you're setting it for",
    body: <>On the left, choose <b>Everyone</b>, a <b>security role</b>, a <b>department</b> or one <b>person</b>. Everything you change in the middle applies to what you picked. Lists can be folded away with the arrow next to their name, and the search box finds anyone.</>,
    art: (
      <div className="pas-tour-list">
        {[["∗", "Everyone", "The starting point for all", "is-everyone"], ["S", "Sales", "Security role · 4 people", "is-role"], ["", "Marketing", "Department · 3 people", "is-dept"], ["AG", "Ana García", "Person", "is-user"]].map(([i, n, sub, c], x) => (
          <span key={n} className={`pas-tour-row ${x === 1 ? "is-on" : ""}`}><i className={`pas-subj-ico ${c}`} style={{ ["--c" as string]: "#e0a13c" } as CSSProperties}>{i}</i><span><b>{n}</b><small>{sub}</small></span></span>
        ))}
      </div>
    ),
  },
  {
    title: "Open or hide each page",
    body: <>Each page of the side menu has three choices. <b>Open</b> and <b>Hidden</b> are a decision for whoever you picked. <b>Inherit</b> means “leave it to the level below” — the small word under it tells you what they get right now.</>,
    art: (
      <div className="pas-tour-card">
        <span className="pas-tour-pg"><span className="pas-card-ico">{PAGE_ICON.clients}</span><span><b>Clients</b><small>Clients and contracts</small></span></span>
        {miniChoice(["Hidden", "Open"], 2, "Hidden")}
      </div>
    ),
  },
  {
    title: "Who wins when settings disagree",
    body: <>The most specific setting wins: <b>Person</b> beats <b>Security role</b>, which beats <b>Department</b>, which beats <b>Everyone</b>. If nobody set anything, the built-in default applies. So you set the general rule once on Everyone, and only the exceptions further up.</>,
    art: (
      <div className="pas-tour-ladder">
        {[["Everyone", "Clients: Hidden", "is-everyone"], ["Sales role", "Clients: Open", "is-role"], ["Ana (person)", "Clients: Hidden", "is-user"]].map(([w, v, c], i) => (
          <span key={w} className={`pas-tour-step ${c}`} style={{ ["--i" as string]: i } as CSSProperties}><b>{w}</b><small>{v}</small></span>
        ))}
        <p>Ana is in Sales, but her own setting wins → <b>she doesn't see Clients</b>. Her Sales colleagues do.</p>
      </div>
    ),
  },
  {
    title: "Panels inside Settings and Management",
    body: <>Under <b>Inside the pages</b> you choose which parts of Settings and Management someone gets. Management panels have a third level: <b>Own</b> shows only their own data, <b>All</b> shows everyone's. The same “who wins” order applies.</>,
    art: (
      <div className="pas-tour-card">
        <span className="pas-tour-pg"><span className="pas-card-ico">{PAGE_ICON.management}</span><span><b>Billing</b><small>Bills and invoices per project</small></span></span>
        {miniChoice(["Hidden", "Own", "All"], 2, "All data")}
      </div>
    ),
  },
  {
    title: "Check the result before saving",
    body: <>On the right, <b>Their side menu</b> shows exactly what the selected person will see, and where each answer comes from. <b>Who sees what</b> (top) shows everyone at once — click a name there to jump straight to their settings.</>,
    art: (
      <div className="pas-tour-dock">
        {(["home", "calendar", "sales", "clients", "management"] as PageKey[]).map((k, i) => (
          <span key={k} className={i === 3 ? "is-off" : ""}><i>{PAGE_ICON[k]}</i>{PAGES.find((p) => p.key === k)!.label}</span>
        ))}
      </div>
    ),
  },
  {
    title: "Save — and what never changes",
    body: <><b>Save changes</b> updates everyone's menu straight away; a hidden page can't be opened by its link either. To keep anyone from being locked out, <b>Bosses</b> and superadmins always get everything, and <b>Home</b>, <b>Settings</b>, <b>Interface</b> and <b>Your account</b> are always open.</>,
    art: (
      <div className="pas-tour-final">
        <span className="pas-tour-save">Save changes</span>
        <span className="pas-tour-lock">{LOCK}Boss · Home · Settings · Interface · Your account</span>
      </div>
    ),
  },
];

function Tour({ onClose }: { onClose: () => void }) {
  const [i, setI] = useState(0);
  const step = TOUR[i];
  const last = i === TOUR.length - 1;
  return (
    <div className="pas-tour-backdrop" onMouseDown={onClose}>
      <div className="pas-tour" role="dialog" aria-modal="true" aria-label="How page access works" onMouseDown={(e) => e.stopPropagation()}>
        <div className="pas-tour-art" key={`a${i}`}>{step.art}</div>
        <div className="pas-tour-body" key={`b${i}`}>
          <span className="pas-eyebrow">How it works · step {i + 1} of {TOUR.length}</span>
          <h3>{step.title}</h3>
          <p>{step.body}</p>
        </div>
        <footer className="pas-tour-foot">
          <div className="pas-tour-dots">{TOUR.map((_, j) => <button key={j} className={j === i ? "is-on" : ""} onClick={() => setI(j)} aria-label={`Step ${j + 1}`} />)}</div>
          <button className="pas-btn is-ghost is-sm" onClick={() => (i ? setI(i - 1) : onClose())}>{i ? "Back" : "Skip"}</button>
          <button className="pas-btn is-primary is-sm" onClick={() => (last ? onClose() : setI(i + 1))} autoFocus>{last ? "Got it" : "Next"}</button>
        </footer>
      </div>
    </div>
  );
}

interface Person extends AccessPerson { name: string; email: string | null; ownRole: string | null }
interface Subject { type: PageSubject; id: string; name: string; sub: string; color?: string; locked?: boolean; people: Person[] }
type OvCols = "pages" | "settings" | "management";

/**
 * Settings → Organization → Page access. Which pages of the side menu each
 * person can open, and which panels they get inside Settings and Management —
 * set for everyone, a department, a security role or one person, and
 * previewed as that person's own side menu.
 *
 * scope="management": only Management's panels can be changed (opened from
 * Management → ⚙ → Security by someone who isn't a Boss).
 */
export default function PageAccessModal({ onClose, scope = "all", focus }: { onClose: () => void; scope?: "all" | "management"; focus?: PageKey }) {
  const { reload } = usePageAccess();
  const onlyMgmt = scope === "management";
  const [loading, setLoading] = useState(true);
  const [people, setPeople] = useState<Person[]>([]);
  const [base, setBase] = useState<PageRules>({});
  const [draft, setDraft] = useState<PageRules>({});
  const [missing, setMissing] = useState(false);
  const [mode, setMode] = useState<"edit" | "overview">("edit");
  const [sel, setSel] = useState("everyone:*");
  const [q, setQ] = useState("");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [ovFilter, setOvFilter] = useState("");
  const [tour, setTour] = useState(() => readLS(TOUR_KEY) !== "1");
  const closeTour = () => { setTour(false); writeLS(TOUR_KEY, "1"); };
  // folded lists in the left column (remembered on this device)
  const [grp, setGrp] = useState<Record<string, boolean>>(() => { try { return JSON.parse(readLS(GROUPS_KEY) || "{}"); } catch { return {}; } });
  const [ovCols, setOvCols] = useState<OvCols>(onlyMgmt || focus === "management" ? "management" : focus === "settings" ? "settings" : "pages");

  useEffect(() => {
    (async () => {
      const [{ rules, missing: m }, profs, depts] = await Promise.all([
        loadPageRules(),
        supabase.from("profiles").select("*").range(0, 99999),
        supabase.from("org_departments").select("dept_key, security_role"),
      ]);
      const deptRole = new Map(((depts.data ?? []) as any[]).map((d) => [d.dept_key, (d.security_role ?? "").toLowerCase() || null]));
      setPeople(((profs.data ?? []) as any[]).filter((p) => p.active !== false).map((p) => {
        const own = (p.role ?? "").toString().toLowerCase() || null;
        return {
          id: p.id, name: [p.first_name, p.last_name].filter(Boolean).join(" ") || p.full_name || p.email || "—", email: p.email ?? null,
          ownRole: own, level: own ?? (p.department ? deptRole.get(p.department) ?? null : null), department: p.department ?? null, isSuper: p.is_superadmin === true,
        };
      }).sort((a, b) => a.name.localeCompare(b.name)));
      setBase(rules); setDraft(rules); setMissing(m); setLoading(false);
    })();
  }, []);

  // Open on the card that was asked for.
  useEffect(() => {
    if (loading || !focus || onlyMgmt) return;
    const t = setTimeout(() => document.getElementById(`pas-card-${focus}`)?.scrollIntoView({ block: "start", behavior: "smooth" }), 250);
    return () => clearTimeout(t);
  }, [loading, focus, sel, onlyMgmt]);

  /* ─────────────── subjects ─────────────── */
  const subjects = useMemo(() => {
    const levels: Subject[] = (LEVELS as any[]).map((l) => {
      const ppl = people.filter((p) => p.level === l.id);
      return { type: "role" as const, id: l.id, name: l.label, sub: `${ppl.length} ${ppl.length === 1 ? "person" : "people"}`, locked: l.id === "boss", people: ppl };
    });
    const depts: Subject[] = (DEPARTMENTS as readonly any[]).map((d) => {
      const ppl = people.filter((p) => p.department === d.key);
      return { type: "dept" as const, id: d.key, name: d.label, sub: `${ppl.length} ${ppl.length === 1 ? "person" : "people"}`, color: d.color, people: ppl };
    });
    const ppl: Subject[] = people.map((p) => ({ type: "user" as const, id: p.id, name: p.name, sub: `${levelLabel(p.level)}${p.department ? ` · ${deptLabel(p.department)}` : ""}`, locked: isFullAccess(p), people: [p] }));
    return { everyone: { type: "everyone" as const, id: "*", name: "Everyone", sub: "The starting point for all", people } as Subject, levels, depts, ppl };
  }, [people]);
  const all = [subjects.everyone, ...subjects.levels, ...subjects.depts, ...subjects.ppl];
  const subject = all.find((s) => pageRuleKey(s.type, s.id) === sel) ?? subjects.everyone;
  const key = pageRuleKey(subject.type, subject.id);
  const own: PageMap = draft[key] ?? {};
  const countKeys = (m: PageMap | undefined) => Object.keys(m ?? {}).filter((k) => !onlyMgmt || k.startsWith("management.")).length;
  const setsOf = (s: Subject) => countKeys(draft[pageRuleKey(s.type, s.id)]);
  const diffKeys = (k: string) => { const a = draft[k] ?? {}, b = base[k] ?? {}; return ALL_KEYS.filter((x) => a[x] !== b[x]); };
  const changedKeys = Array.from(new Set([...Object.keys(draft), ...Object.keys(base)])).filter((k) => diffKeys(k).length > 0);
  // how many single settings differ from what's saved
  const dirty = changedKeys.reduce((n, k) => n + diffKeys(k).length, 0);

  /* ─────────────── edits ─────────────── */
  const setKey = (k: string, v: boolean | Level | undefined) => {
    setSaved(false);
    setDraft((d) => {
      const m = { ...(d[key] ?? {}) };
      if (v === undefined) delete m[k]; else m[k] = v;
      const out = { ...d };
      if (Object.keys(m).length) out[key] = m; else delete out[key];
      return out;
    });
  };
  const resetSubject = () => {
    setSaved(false);
    setDraft((d) => {
      const o = { ...d };
      if (!onlyMgmt) { delete o[key]; return o; }
      const m = Object.fromEntries(Object.entries(o[key] ?? {}).filter(([k]) => !k.startsWith("management.")));
      if (Object.keys(m).length) o[key] = m; else delete o[key];
      return o;
    });
  };

  /* what a page / panel falls back to for this subject */
  const probes = (s: Subject): AccessPerson[] => {
    if (s.type === "user") return s.people;
    if (s.type === "role") return [{ id: "__probe", level: s.id, department: null }];
    if (s.type === "dept") return s.people.length ? s.people : [{ id: "__probe", level: null, department: s.id }];
    return (LEVELS as any[]).filter((l) => l.id !== "boss").map((l) => ({ id: "__probe", level: l.id, department: null }));
  };
  const inherited = (k: string): { text: string; level: Level | null; source?: PageSourceKind } => {
    const without = { ...draft, [key]: (() => { const m = { ...own }; delete m[k]; return m; })() };
    const vals = probes(subject).filter((p) => !isFullAccess(p)).map((p) => resolveAny(k, p, without));
    if (!vals.length) return { text: "—", level: null };
    const distinct = Array.from(new Set(vals.map((v) => v.level)));
    if (distinct.length === 1) return { text: levelText(k, distinct[0]), level: distinct[0], source: vals[0].source };
    return { text: "Depends", level: null };
  };

  /* ─────────────── preview ─────────────── */
  const previewPool = subject.type === "everyone" ? people : subject.people;
  const previewPerson = previewPool.find((p) => p.id === previewId) ?? previewPool.find((p) => !isFullAccess(p)) ?? previewPool[0] ?? null;
  const previewPages = previewPerson ? resolveAllPages(previewPerson, draft) : null;

  /* ─────────────── save ─────────────── */
  const save = async () => {
    setBusy(true); setErr(null);
    const e = await savePageRules(draft, base);
    setBusy(false);
    if (e) {
      setErr(/page_access_rules|does not exist|schema cache/.test(e) ? "Run empower_page_access_v3.sql in Supabase first, then save again."
        : /row-level security|Only the Boss/.test(e) ? (onlyMgmt ? "You can only change Management's panels." : "Only the Boss security level can change page access.") : e);
      return;
    }
    setBase(draft); setSaved(true);
    await reload();
    window.dispatchEvent(new Event(SECURITY_LEVEL_EVENT));
  };
  const close = () => { if (dirty && !window.confirm("Close without saving your changes?")) return; onClose(); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key !== "Escape") return; if (tour) closeTour(); else close(); };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }); // eslint-disable-line react-hooks/exhaustive-deps

  /* ─────────────── bits ─────────────── */
  const filtered = (list: Subject[]) => { const n = q.trim().toLowerCase(); return n ? list.filter((s) => s.name.toLowerCase().includes(n) || s.sub.toLowerCase().includes(n)) : list; };
  const SubjectBtn = ({ s, i }: { s: Subject; i: number }) => {
    const k = pageRuleKey(s.type, s.id);
    const n = setsOf(s);
    return (
      <button className={`pas-subj ${k === sel ? "is-on" : ""}`} onClick={() => { setSel(k); setPreviewId(null); setMode("edit"); }} style={{ ["--c" as string]: s.color ?? "#9fb5ab", ["--i" as string]: Math.min(i, 16) } as CSSProperties}>
        <span className={`pas-subj-ico is-${s.type}`}>{s.type === "everyone" ? "∗" : s.type === "dept" ? "" : initials(s.name)}</span>
        <span className="pas-subj-txt"><b>{s.name}</b><small>{s.locked ? "Everything, always" : s.sub}</small></span>
        {changedKeys.includes(k) ? <em className="pas-dot" title="Unsaved changes" /> : n > 0 ? <em className="pas-count" title={`${n} settings here`}>{n}</em> : null}
      </button>
    );
  };
  const GROUP_DEFAULT: Record<string, boolean> = { roles: true, depts: true, people: people.length <= 8, order: true };
  const groupOpen = (g: string) => grp[g] ?? GROUP_DEFAULT[g];
  const setGroups = (next: Record<string, boolean>) => { setGrp(next); writeLS(GROUPS_KEY, JSON.stringify(next)); };
  const toggleGroup = (g: string) => setGroups({ ...grp, [g]: !groupOpen(g) });
  const setAllGroups = (open: boolean) => setGroups({ roles: open, depts: open, people: open, order: grp.order ?? true });
  const searching = q.trim().length > 0;
  const navGroup = (g: string, label: string, list: Subject[], offset: number) => {
    const items = filtered(list);
    if (!items.length) return null;
    const open = searching || groupOpen(g);
    const withSettings = list.filter((s) => setsOf(s) > 0).length;
    const changed = list.some((s) => changedKeys.includes(pageRuleKey(s.type, s.id)));
    const selectedHere = list.find((s) => pageRuleKey(s.type, s.id) === sel);
    return (
      <section className={`pas-grp ${open ? "is-open" : ""}`}>
        <button className="pas-grp-h" onClick={() => toggleGroup(g)} aria-expanded={open} disabled={searching} title={searching ? undefined : open ? "Hide this list" : "Show this list"}>
          <span className="pas-grp-chev">{CHEVRON}</span>
          <span className="pas-grp-lbl">{label}</span>
          <em className="pas-grp-n">{searching ? `${items.length}/${list.length}` : list.length}</em>
          {changed ? <i className="pas-dot" title="Unsaved changes in this list" /> : withSettings > 0 && <small>{withSettings} set</small>}
        </button>
        {open
          ? <div className="pas-grp-items">{items.map((s, i) => <SubjectBtn key={s.id} s={s} i={i + offset} />)}</div>
          : selectedHere && <div className="pas-grp-items is-peek"><SubjectBtn s={selectedHere} i={0} /></div>}
      </section>
    );
  };
  const typeLabel = { everyone: "Everyone", role: "Security role", dept: "Department", user: "Person" }[subject.type];
  const visibleCount = (p: Person) => PAGES.filter((x) => resolvePage(x.key, p, draft).allowed).length;

  /** Inherit · Hidden · (Own) · Open/All for one page or panel. */
  const choice = (k: string, levels: Level[], label: string) => {
    const v = asLv(own[k]);
    const inh = inherited(k);
    return (
      <div className={`pas-choice ${levels.length > 2 ? "is-4" : ""}`} role="radiogroup" aria-label={label}>
        <button role="radio" aria-checked={v === undefined} className={`is-inherit ${v === undefined ? "is-on" : ""}`} onClick={() => setKey(k, undefined)} title={inh.source ? `From ${SOURCE_LABEL[inh.source]}` : undefined}>
          <span>{subject.type === "everyone" ? "Default" : "Inherit"}</span><small>{inh.text}</small>
        </button>
        {levels.map((l) => (
          <button key={l} role="radio" aria-checked={v === l} className={`${l === "none" ? "is-neg" : l === "own" ? "is-own" : ""} ${v === l ? "is-on" : ""}`} onClick={() => setKey(k, stored(k, l))}>
            <span>{l === "none" ? "Hidden" : levels.length > 2 ? (l === "own" ? "Own" : "All") : "Open"}</span>
          </button>
        ))}
      </div>
    );
  };
  /** The level in effect for a page/panel on this subject (own setting, else what it inherits). */
  const effective = (k: string): Level | null => asLv(own[k]) ?? inherited(k).level;

  const panelRow = (p: PanelDef, i: number) => {
    const eff = effective(p.key);
    return (
      <div key={p.key} className={`pas-panel ${p.locked ? "is-locked" : eff === "none" ? "is-hidden" : eff ? "is-open" : ""} ${own[p.key] !== undefined ? "is-set" : ""}`} style={{ ["--i" as string]: i } as CSSProperties}>
        <span className="pas-panel-txt"><b>{p.label}</b><small>{p.hint}</small></span>
        {p.locked ? <span className="pas-always is-sm">{LOCK}Always open</span> : choice(p.key, p.levels, p.label)}
      </div>
    );
  };

  const pageCard = (p: (typeof PAGES)[number], i: number) => {
    const panels = panelsOf(p.key);
    const eff = p.locked ? "all" : effective(p.key);
    const wide = panels.length > 0;
    const cls = `pas-card ${wide ? "is-wide" : ""} ${p.locked ? "is-locked" : eff === "all" ? "is-open" : eff === "none" ? "is-hidden" : ""} ${own[p.key] !== undefined ? "is-set" : ""}`;
    const pageCtl = p.locked
      ? <span className="pas-always">{LOCK}Always open</span>
      : onlyMgmt ? <span className={`pas-always is-ro ${eff === "none" ? "is-off" : ""}`}>{eff === "none" ? "Page hidden" : eff === "all" ? "Page open" : "Page: depends"} · set by the Boss</span>
      : choice(p.key, ["none", "all"], p.label);
    return (
      <article key={p.key} id={`pas-card-${p.key}`} className={cls} style={{ ["--i" as string]: i } as CSSProperties}>
        <header>
          <span className="pas-card-ico">{PAGE_ICON[p.key]}</span>
          <span className="pas-card-txt"><b>{p.label}</b><small>{p.hint}</small></span>
          {wide && <div className="pas-card-ctl">{pageCtl}</div>}
        </header>
        {!wide && pageCtl}
        {p.inside && !p.locked && <small className="pas-inside">What they can do inside: {p.inside}</small>}
        {wide && (
          <div className="pas-panels">
            <p className="pas-panels-h">
              <span>Panels inside {p.label}</span>
              {p.key === "management" && <em>Own = only their own data · All = everyone's</em>}
              {eff === "none" && <em className="is-warn">The page is hidden, so these only apply once it's opened</em>}
            </p>
            {panels.map((x, j) => panelRow(x, j))}
          </div>
        )}
      </article>
    );
  };

  const ovKeys: { key: string; label: string; icon?: ReactNode }[] =
    ovCols === "pages" ? PAGES.map((p) => ({ key: p.key, label: p.label, icon: PAGE_ICON[p.key] }))
      : panelsOf(ovCols).filter((p) => !p.locked).map((p) => ({ key: p.key, label: p.label }));

  return createPortal(
    <div className="pas-backdrop" onMouseDown={close}>
      <div className="pas" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Page access">
        <header className="pas-head">
          <span className="pas-head-ico">{svg(<><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" /><path d="M9 12l2 2 4-4" /></>)}</span>
          <div className="pas-head-txt">
            <span className="pas-eyebrow">{onlyMgmt ? "Management" : "Organization"}</span>
            <h2>{onlyMgmt ? "Management access" : "Page access"}</h2>
          </div>
          <div className="pas-mode" role="tablist">
            <button role="tab" aria-selected={mode === "edit"} className={mode === "edit" ? "is-on" : ""} onClick={() => setMode("edit")}>Edit</button>
            <button role="tab" aria-selected={mode === "overview"} className={mode === "overview" ? "is-on" : ""} onClick={() => setMode("overview")}>Who sees what</button>
          </div>
          <div className="pas-head-actions">
            <button className="pas-help" onClick={() => setTour(true)} title="A quick step-by-step on how this works">
              {svg(<><circle cx="12" cy="12" r="9" /><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6M12 17.2h.01" /></>, 2)}
              <span>How it works</span>
            </button>
            {saved && !dirty && <span className="pas-saved">Saved · menus updated</span>}
            {dirty > 0 && <span className="pas-dirty">{dirty} unsaved {dirty === 1 ? "change" : "changes"}</span>}
            <button className="pas-btn is-ghost" onClick={() => { setDraft(base); setErr(null); }} disabled={!dirty || busy}>Discard</button>
            <button className="pas-btn is-primary" onClick={save} disabled={!dirty || busy}>{busy ? "Saving…" : "Save changes"}</button>
            <button className="pas-x" onClick={close} aria-label="Close">×</button>
          </div>
        </header>
        {(missing || err || onlyMgmt) && (
          <div className="pas-banners">
            {missing && <p className="pas-banner">Run <code>empower_page_access_v3.sql</code> in Supabase once — until then only security-role page settings can be read, and nothing can be saved.</p>}
            {onlyMgmt && !missing && <p className="pas-banner is-soft">You can change who sees each panel of Management. Which pages people open, and the panels in Settings, are set by the Boss in Settings → Organization → Page access.</p>}
            {err && <p className="pas-banner is-err">{err}</p>}
          </div>
        )}

        {loading ? <div className="pas-loading">Loading…</div> : mode === "overview" ? (
          /* ─────────── overview: every person × every page / panel ─────────── */
          <div className="pas-ov">
            <div className="pas-ov-top">
              {!onlyMgmt && (
                <div className="pas-seg" role="tablist" aria-label="Columns">
                  {(["pages", "settings", "management"] as OvCols[]).map((c) => (
                    <button key={c} role="tab" aria-selected={ovCols === c} className={ovCols === c ? "is-on" : ""} onClick={() => setOvCols(c)}>
                      {c === "pages" ? "Side menu" : c === "settings" ? "Settings panels" : "Management panels"}
                    </button>
                  ))}
                </div>
              )}
              <p>{ovCols === "pages" ? "What each person's side menu shows" : `What each person gets inside ${ovCols === "settings" ? "Settings" : "Management"}`}{dirty ? " (with your unsaved changes)" : ""}. Click a name to change it.</p>
              <input className="pas-search" value={ovFilter} onChange={(e) => setOvFilter(e.target.value)} placeholder="Filter people, roles or departments…" aria-label="Filter" />
            </div>
            <div className="pas-ov-scroll">
              <table className="pas-ov-table">
                <thead>
                  <tr>
                    <th className="pas-ov-who">Person</th>
                    {ovKeys.map((c) => <th key={c.key} title={c.label}>{c.icon && <span className="pas-ov-ico">{c.icon}</span>}<span className={c.icon ? "" : "pas-ov-lbl"}>{c.label}</span></th>)}
                  </tr>
                </thead>
                <tbody>
                  {people.filter((p) => { const n = ovFilter.trim().toLowerCase(); return !n || `${p.name} ${levelLabel(p.level)} ${deptLabel(p.department)}`.toLowerCase().includes(n); }).map((p) => {
                    const pageOff = ovCols !== "pages" && !resolvePage(ovCols, p, draft).allowed;
                    return (
                      <tr key={p.id} className={pageOff ? "is-pageoff" : ""}>
                        <th className="pas-ov-who">
                          <button onClick={() => { setSel(pageRuleKey("user", p.id)); setMode("edit"); }}>
                            <span className="pas-av">{initials(p.name)}</span>
                            <span><b>{p.name}</b><small>{pageOff ? `${ovCols === "settings" ? "Settings" : "Management"} page hidden` : `${levelLabel(p.level)} · ${deptLabel(p.department)}`}</small></span>
                          </button>
                        </th>
                        {ovKeys.map((c) => {
                          const r = resolveAny(c.key, p, draft);
                          return (
                            <td key={c.key}>
                              <span className={`pas-ov-cell ${r.level !== "none" ? "is-on" : ""} lv-${r.level} is-${r.source}`} title={`${c.label}: ${levelText(c.key, r.level)} · ${SOURCE_LABEL[r.source]}`}>
                                {r.level === "own" ? <b>Own</b> : r.level === "all" ? CHECK : DASH}
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="pas-legend">
              <span><i className="is-user" />Set for the person</span><span><i className="is-role" />Security role</span><span><i className="is-dept" />Department</span>
              <span><i className="is-everyone" />Everyone</span><span><i className="is-default" />Default</span><span><i className="is-boss" />Always open · full access</span>
              {ovCols === "management" && <span><i className="is-own" />Own = only their own data</span>}
            </div>
          </div>
        ) : (
          <div className="pas-body">
            {/* ─────────── who ─────────── */}
            <nav className="pas-nav">
              <input className="pas-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people, roles, departments…" aria-label="Search" />
              {!searching && (
                <div className="pas-nav-tools">
                  <button onClick={() => setAllGroups(true)}>Expand all</button>
                  <span aria-hidden="true">·</span>
                  <button onClick={() => setAllGroups(false)}>Collapse all</button>
                </div>
              )}
              <div className="pas-nav-scroll">
                {!searching && <SubjectBtn s={subjects.everyone} i={0} />}
                {navGroup("roles", "Security roles", subjects.levels, 1)}
                {navGroup("depts", "Departments", subjects.depts, 3)}
                {navGroup("people", "People", subjects.ppl, 5)}
                {searching && !filtered([...subjects.levels, ...subjects.depts, ...subjects.ppl]).length && <p className="pas-nav-empty">Nobody matches “{q.trim()}”.</p>}
              </div>
              <div className={`pas-order ${groupOpen("order") ? "is-open" : ""}`}>
                <button className="pas-order-h" onClick={() => toggleGroup("order")} aria-expanded={groupOpen("order")}>
                  <span className="pas-grp-chev">{CHEVRON}</span>Who wins
                  <span className="pas-order-q" role="link" tabIndex={0} onClick={(e) => { e.stopPropagation(); setTour(true); }} onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); setTour(true); } }}>What's this?</span>
                </button>
                {groupOpen("order") && <ol aria-label="Order of priority"><li>Person</li><li>Security role</li><li>Department</li><li>Everyone</li></ol>}
              </div>
            </nav>

            {/* ─────────── pages ─────────── */}
            <main className="pas-main" key={sel}>
              <section className="pas-hero" style={{ ["--c" as string]: subject.color ?? "#12b57f" } as CSSProperties}>
                <span className={`pas-hero-ico is-${subject.type}`}>{subject.type === "everyone" ? "∗" : initials(subject.name)}</span>
                <div>
                  <span className="pas-hero-type">{typeLabel}</span>
                  <h3>{subject.name}</h3>
                  <p>
                    {subject.locked ? "Always gets every page and panel — this can't be limited, so nobody gets locked out."
                      : subject.type === "everyone" ? "What everyone gets, unless their department, security role or own settings say otherwise."
                      : subject.type === "user" ? "Just for this person. Anything on “Inherit” comes from their security role, department or Everyone."
                      : `Applies to ${subject.people.length} ${subject.people.length === 1 ? "person" : "people"}. Anything on “Inherit” comes from ${subject.type === "role" ? "their department or Everyone" : "Everyone"}.`}
                  </p>
                  {subject.type === "user" && subject.people[0] && (
                    <span className="pas-hero-meta"><i>{levelLabel(subject.people[0].level)}{subject.people[0].ownRole ? "" : " (from department)"}</i><i style={{ ["--c" as string]: deptColor(subject.people[0].department) } as CSSProperties} className="is-dept">{deptLabel(subject.people[0].department)}</i></span>
                  )}
                </div>
                {!subject.locked && setsOf(subject) > 0 && <button className="pas-reset" onClick={resetSubject}>Reset to inherit</button>}
              </section>

              {subject.locked ? (
                <div className="pas-locked">{LOCK}<p>Bosses and superadmins see every page and panel. To limit someone, give them another security role.</p></div>
              ) : onlyMgmt ? (
                <div className="pas-grid">{PAGES.filter((p) => p.key === "management").map((p, i) => pageCard(p, i))}</div>
              ) : (
                <>
                  <h4 className="pas-sec-h">Side menu</h4>
                  <div className="pas-grid">{PAGES.filter((p) => !panelsOf(p.key).length).map((p, i) => pageCard(p, i))}</div>
                  <h4 className="pas-sec-h">Inside the pages</h4>
                  <div className="pas-grid">{PAGES.filter((p) => panelsOf(p.key).length).map((p, i) => pageCard(p, i))}</div>
                </>
              )}
            </main>

            {/* ─────────── their side menu ─────────── */}
            <aside className="pas-preview">
              <h4>Their side menu</h4>
              {!previewPerson || !previewPages ? <p className="pas-note">Nobody here yet.</p> : (
                <>
                  <select className="pas-select" value={previewPerson.id} onChange={(e) => setPreviewId(e.target.value)} aria-label="Preview as">
                    {previewPool.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <div className="pas-dock">
                    {PAGES.map((p) => {
                      const r = previewPages[p.key];
                      const subs = panelsOf(p.key).filter((x) => !x.locked);
                      return (
                        <div key={p.key} className={`pas-dock-row ${r.allowed ? "is-on" : "is-off"}`}>
                          <div className={`pas-dock-item ${r.allowed ? "is-on" : "is-off"}`} title={`${SOURCE_LABEL[r.source]}`}>
                            <span className="pas-dock-ico">{PAGE_ICON[p.key]}</span>
                            <span className="pas-dock-lbl">{p.label}</span>
                            <i className={`pas-src is-${r.source}`}>{r.allowed ? SOURCE_LABEL[r.source] : `Hidden · ${SOURCE_LABEL[r.source]}`}</i>
                          </div>
                          {r.allowed && subs.length > 0 && (
                            <div className="pas-dock-sub">
                              {subs.map((x) => {
                                const l = resolveAny(x.key, previewPerson, draft).level;
                                return <span key={x.key} className={`lv-${l}`} title={`${x.label}: ${levelText(x.key, l)}`}>{x.label}{l === "own" ? " · own" : ""}</span>;
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <p className="pas-note">{previewPerson.name.split(" ")[0]} sees <b>{visibleCount(previewPerson)}</b> of {PAGES.length} pages. A hidden page or panel also can't be opened by its link.</p>
                </>
              )}
            </aside>
          </div>
        )}
        {tour && !loading && <Tour onClose={closeTour} />}
      </div>
    </div>,
    document.body,
  );
}