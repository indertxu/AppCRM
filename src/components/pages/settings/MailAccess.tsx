/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { supabase } from "../../api/supabase";
import MultiSelect from "../../framework/MultiSelect";
import { loadDepartments, usePageAccess, useSecurityLevels, levelBase, isManagerLevel, type Department } from "../../framework/pageAccess";
import "./PageAccessModal.css";
import "./MailAccess.css";

/* =====================================================================
   Settings › Tickets › E-mail (SQL 139). Both settings live in one row of
   page_data_scopes (page "mail_view") and the database applies them — the
   app only shows what it is allowed to read:
   • keep: "clients" (default) — only mail with a client is stored and shown;
     "crm" — clients and anyone in Companies / Contacts (the rule before).
   • who sees whose mail, by mailbox owner: a person › their security role ›
     their department › everyone; bosses and superadmins see all.
   ===================================================================== */

export type MailSee = "own" | "reports" | "people" | "department" | "teams" | "all";
export interface MailRule { see: MailSee; people?: string[]; depts?: string[]; shared?: boolean }
export interface MailRules { keep: "clients" | "crm"; everyone: MailRule | null; roles: Record<string, MailRule>; depts: Record<string, MailRule>; users: Record<string, MailRule> }
const PAGE = "mail_view";
const EMPTY: MailRules = { keep: "clients", everyone: null, roles: {}, depts: {}, users: {} };


/** What applies when nothing is set (same as the database): managers their department, the rest their own. */
const fallback = (role: string): MailRule => (isManagerLevel(role) ? { see: "department", shared: true } : { see: "own", shared: true });

interface Person { id: string; name: string; role: string; department: string | null; manager: string | null; job: string | null; full: boolean }
/** The rule that applies to a person, and where it comes from. */
function resolve(rules: MailRules, p: Person, levelLabel: (k: string) => string, deptLabel: (k: string | null) => string): { rule: MailRule; from: string; kind: "boss" | "user" | "role" | "dept" | "everyone" | "default" } {
  if (rules.users[p.id]) return { rule: rules.users[p.id], from: "Their own setting", kind: "user" };
  if (p.full) return { rule: { see: "all", shared: true }, from: "Boss — reads everything", kind: "boss" };
  if (p.role && rules.roles[p.role]) return { rule: rules.roles[p.role], from: `Role: ${levelLabel(p.role)}`, kind: "role" };
  if (p.department && rules.depts[p.department]) return { rule: rules.depts[p.department], from: `Department: ${deptLabel(p.department)}`, kind: "dept" };
  if (rules.everyone) return { rule: rules.everyone, from: "Everyone", kind: "everyone" };
  return { rule: fallback(p.role), from: isManagerLevel(p.role) ? "Default for managers" : "Default", kind: "default" };
}
/** Everyone below a person in the org chart. */
function below(id: string, people: Person[]): Set<string> {
  const out = new Set<string>(); let frontier = [id];
  while (frontier.length) {
    const next = people.filter((p) => p.manager && frontier.includes(p.manager) && !out.has(p.id) && p.id !== id).map((p) => p.id);
    next.forEach((x) => out.add(x)); frontier = next;
  }
  return out;
}
/** Whose mail a person reads (besides their own), as the database decides it. */
function readsOf(p: Person, rule: MailRule, people: Person[]): Person[] {
  const extra = new Set(rule.people ?? []);
  const tree = rule.see === "reports" ? below(p.id, people) : null;
  return people.filter((o) => {
    if (o.id === p.id) return false;
    if (p.full || rule.see === "all" || extra.has(o.id)) return true;
    if (tree) return tree.has(o.id);
    if (rule.see === "department") return !!p.department && o.department === p.department;
    if (rule.see === "teams") return !!o.department && (rule.depts ?? []).includes(o.department);
    return false;
  });
}

async function loadRules(): Promise<{ rules: MailRules; missing: boolean }> {
  const { data, error } = await supabase.from("page_data_scopes").select("rules").eq("page", PAGE).maybeSingle();
  if (error) return { rules: { ...EMPTY }, missing: true };
  const r = ((data as any)?.rules ?? {}) as Partial<MailRules>;
  return { rules: { keep: r.keep === "crm" ? "crm" : "clients", everyone: r.everyone ?? null, roles: r.roles ?? {}, depts: r.depts ?? {}, users: r.users ?? {} }, missing: false };
}
async function saveRules(rules: MailRules): Promise<string | null> {
  const { error } = await supabase.from("page_data_scopes").upsert({ page: PAGE, rules, updated_at: new Date().toISOString() }, { onConflict: "tenant_id,page" });
  return error ? error.message : null;
}

const svg = (children: ReactNode, w = 1.9) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round">{children}</svg>;
const CHECK = svg(<path d="M5 12.5l4.5 4.5L19 7.5" />, 2.6);
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";


/** Shared state of the two sections (one row in the database). */
function useMailRules() {
  const { level, isSuper } = usePageAccess();
  const canEdit = isSuper || levelBase(level) === "boss";
  const [rules, setRules] = useState<MailRules | null>(null);
  const [missing, setMissing] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const t = useRef(0);
  useEffect(() => { void loadRules().then((r) => { setRules(r.rules); setMissing(r.missing); }); }, []);
  /** Saves only what changed, on top of what's in the database (the other section may have saved meanwhile). */
  const commit = async (patch: Partial<MailRules>) => {
    setRules((r) => (r ? { ...r, ...patch } : r)); setState("saving"); setErr(null);
    const cur = await loadRules();
    const e = await saveRules({ ...cur.rules, ...patch });
    if (e) { setState("error"); setErr(e); return; }
    setState("saved"); window.clearTimeout(t.current); t.current = window.setTimeout(() => setState("idle"), 1800);
  };
  return { rules, missing, state, err, commit, canEdit };
}
const Saved = ({ state }: { state: string }) => (
  <span className={`psec-state is-${state}`} aria-live="polite">{state === "saving" ? "Saving…" : state === "saved" ? <>{CHECK}Saved</> : state === "error" ? "Not saved" : ""}</span>
);

/* ---------- 1. which mail comes into the app ---------- */
export function MailPrivacy() {
  const { rules, missing, state, err, commit, canEdit } = useMailRules();
  const [stats, setStats] = useState<{ clients: number; domains: number } | null>(null);
  useEffect(() => {
    void Promise.all([
      supabase.from("clients").select("id", { count: "exact", head: true }),
      supabase.from("ticket_mail_rules").select("id", { count: "exact", head: true }).eq("scope", "client").eq("active", true),
    ]).then(([a, b]) => setStats({ clients: a.count ?? 0, domains: b.count ?? 0 })).catch(() => {});
  }, []);
  if (!rules) return <div className="pxa-skel" />;
  const pick = (keep: "clients" | "crm") => { if (canEdit && keep !== rules.keep) void commit({ keep }); };
  return (
    <div className="mva">
      <div className="psec-lead">
        <span className="psec-shield">{svg(<><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" /><path d="M9 12l2 2 4-4" /></>)}</span>
        <p>Which e-mails the app takes from the connected mailboxes (Tickets › Inbox, a client's Emails, tickets made from mail). The database checks every e-mail as it arrives and again whenever anyone reads it: what doesn't pass is never stored, and older mail that doesn't pass stays hidden.</p>
        <Saved state={state} />
      </div>
      {missing && <p className="pa2-warn"><span>Run <b>139_mail_clients_only.sql</b> in Supabase to save this.</span></p>}
      {err && !missing && <p className="pa2-warn"><span>{err}</span></p>}
      {!canEdit && <p className="psec-note">Only a Boss or a superadmin can change this.</p>}

      <div className="mva-keep" role="radiogroup" aria-label="Which mail">
        <button type="button" role="radio" aria-checked={rules.keep === "clients"} disabled={!canEdit} className={`mva-opt ${rules.keep === "clients" ? "is-on" : ""}`} onClick={() => pick("clients")}>
          <span className="mva-opt-ico is-lock">{svg(<><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>)}</span>
          <span className="mva-opt-t"><b>Clients only <i>Recommended</i></b><small>Mail to or from a client: a person on a client's contact list, someone at the client's company (its address, its website's domain, its contacts), or what a client mail rule files to a client. Nothing from prospects, partners, suppliers or newsletters.</small></span>
          {rules.keep === "clients" && <i className="mva-tick">{CHECK}</i>}
        </button>
        <button type="button" role="radio" aria-checked={rules.keep === "crm"} disabled={!canEdit} className={`mva-opt ${rules.keep === "crm" ? "is-on" : ""}`} onClick={() => pick("crm")}>
          <span className="mva-opt-ico">{svg(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><circle cx="17.5" cy="9" r="2.5" /><path d="M16 14.5a5 5 0 0 1 5.5 5" /></>)}</span>
          <span className="mva-opt-t"><b>Clients and the CRM</b><small>Also anyone in Companies or Contacts (prospects, partners). Needed only if you track replies to marketing campaigns from your mailbox.</small></span>
          {rules.keep === "crm" && <i className="mva-tick">{CHECK}</i>}
        </button>
      </div>
      <ul className="mva-facts">
        <li><b>{stats?.clients ?? "…"}</b> clients count — active and churned</li>
        <li><b>{stats?.domains ?? "…"}</b> client mail rules add their addresses or domains (Settings › Clients)</li>
        <li>Public domains (gmail, outlook…) only count by the exact address; your own company's domain never does</li>
        <li>Outgoing mail counts when one of its recipients is a client</li>
      </ul>
    </div>
  );
}

/* ---------- 2. who sees whose mail ---------- */
/* ---------- 2. who reads whose mail ---------- */
type Lane = "own" | "some" | "all";
const LANES: { k: Lane; title: string; hint: string; ico: ReactNode }[] = [
  { k: "own", title: "Only their own", hint: "Their mailbox and their tickets' mail", ico: svg(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>) },
  { k: "some", title: "Theirs + some colleagues", hint: "Pick whose mail they also read", ico: svg(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><circle cx="17.5" cy="9" r="2.5" /><path d="M16 14.5a5 5 0 0 1 5.5 5" /></>) },
  { k: "all", title: "Everyone's", hint: "Every mailbox in the company", ico: svg(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>) },
];

/* Whose mail: three lists — drag people between them; in the middle one, pick whose mail they also read.
   Each move saves a rule for that person (users[id]): own → {see:"own"}, middle → {see:"people", people}, all → {see:"all"}.
   People nobody moved yet sit where the older rules (role / department / Everyone / default) put them. */
export function MailVisibility() {
  const { rules, missing, state, err, commit, canEdit } = useMailRules();
  const LEVELS = useSecurityLevels();
  const [depts, setDepts] = useState<Department[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<Lane | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [ds, profs] = await Promise.all([loadDepartments(true), supabase.from("profiles").select("*").range(0, 99999)]);
      if (!alive) return;
      setDepts(ds);
      setPeople(((profs.data ?? []) as any[]).filter((p) => p.active !== false && !p.is_superadmin).map((p) => ({
        id: p.id, name: [p.first_name, p.last_name].filter(Boolean).join(" ") || p.email || "—",
        role: String(p.security_level ?? p.role ?? "").toLowerCase(), department: p.department ?? null, manager: p.manager_id ?? null, job: p.job_title ?? null,
        full: String(p.role ?? "").toLowerCase() === "boss" || String(p.security_level ?? "").toLowerCase() === "boss",
      })).sort((a, b) => a.name.localeCompare(b.name)));
    })();
    return () => { alive = false; };
  }, []);
  useEffect(() => { if (!fresh) return; const t = window.setTimeout(() => setFresh(null), 4000); return () => window.clearTimeout(t); }, [fresh]);
  if (!rules) return <div className="pxa-skel" />;

  const deptOf = (k: string | null) => depts.find((d) => d.key === k);
  const levelLabel = (k: string) => LEVELS.find((l) => l.key === k)?.name ?? (k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, " "));
  const deptLabel = (k: string | null) => deptOf(k)?.name ?? (k ? k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, " ") : "No department");
  const res = (p: Person) => resolve(rules, p, levelLabel, deptLabel);
  /** a Boss reads everything until someone puts them in a list (SQL 141) */
  const isFree = (p: Person) => p.full && !rules.users[p.id];
  const laneOf = (p: Person): Lane => {
    if (isFree(p)) return "all";
    const own = rules.users[p.id];
    if (own?.see === "people") return "some";
    const { rule } = res(p);
    if (rule.see === "all") return "all";
    return readsOf({ ...p, full: false }, rule, people).length ? "some" : "own";
  };
  const setUser = (id: string, v: MailRule | null) => {
    const m = { ...rules.users };
    if (v) m[id] = v; else delete m[id];
    void commit({ users: m });
  };
  const move = (id: string, lane: Lane) => {
    const p = people.find((x) => x.id === id);
    if (!p || !canEdit || laneOf(p) === lane) return;
    const shared = rules.users[id]?.shared ?? true;
    if (lane === "all") setUser(id, { see: "all", shared });
    else if (lane === "own") setUser(id, { see: "own", people: [], shared });
    else { setUser(id, { see: "people", people: isFree(p) ? [] : readsOf({ ...p, full: false }, res(p).rule, people).map((o) => o.id), shared }); setFresh(id); }
  };
  const needle = q.trim().toLowerCase();
  const shown = needle ? people.filter((p) => `${p.name} ${deptLabel(p.department)} ${levelLabel(p.role || "")} ${p.job ?? ""}`.toLowerCase().includes(needle)) : people;
  const colour = (p: Person) => deptOf(p.department)?.color ?? "#9fb5ab";

  const card = (p: Person, lane: Lane, i: number) => {
    const { rule, from, kind } = res(p);
    const own = rules.users[p.id];
    const reads = lane === "some" ? readsOf({ ...p, full: isFree(p) }, rule, people) : [];
    const locked = !canEdit;
    return (
      <div key={p.id} className={`mvb-card ${drag === p.id ? "is-drag" : ""} ${fresh === p.id ? "is-fresh" : ""} ${p.full ? "is-boss" : ""}`}
        style={{ "--c": colour(p), "--i": i } as CSSProperties} draggable={!locked}
        onDragStart={(e) => { e.dataTransfer.setData("text/plain", p.id); e.dataTransfer.effectAllowed = "move"; setDrag(p.id); }}
        onDragEnd={() => { setDrag(null); setOver(null); }}>
        <div className="mvb-card-h">
          <span className="psec-av">{initials(p.name)}</span>
          <span className="mvb-id"><b>{p.name}</b><small>{[p.job || levelLabel(p.role || "—"), deptLabel(p.department)].join(" · ")}</small></span>
          {p.full && <span className="mvb-tag is-boss" title={own ? "A Boss, but this list decides" : "A Boss reads every mailbox until you put them in a list"}>Boss</span>}
          {own ? (canEdit && <button type="button" className="mvb-reset" title="Back to the default" aria-label={`Back to the default for ${p.name}`} onClick={() => setUser(p.id, null)}>{svg(<><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></>, 2)}</button>)
            : !p.full && <span className="mvb-tag" title={`Nobody moved them yet: ${from}`}>{kind === "default" ? "Default" : from.replace(/^(Department|Role): /, "")}</span>}
          {!locked && <span className="mvb-grip" aria-hidden="true">{svg(<><circle cx="9" cy="6" r="1" /><circle cx="15" cy="6" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="18" r="1" /><circle cx="15" cy="18" r="1" /></>, 2.4)}</span>}
        </div>
        {lane === "some" && (
          <div className="mvb-pick" onDragStart={(e) => e.preventDefault()}>
            {canEdit ? (
              <MultiSelect values={reads.map((o) => o.id)} placeholder="Pick colleagues…" noun="colleagues"
                options={people.filter((o) => o.id !== p.id).map((o) => ({ value: o.id, label: `${o.name} · ${deptLabel(o.department)}` }))}
                onChange={(vs) => { setFresh(null); setUser(p.id, { see: "people", people: vs, shared: own?.shared ?? rule.shared ?? true }); }} />
            ) : <span className="mvb-none">{reads.length} colleagues</span>}
            {reads.length > 0 && (
              <span className="mvb-who">
                {reads.slice(0, 6).map((o, j) => <span key={o.id} title={`${o.name} · ${deptLabel(o.department)}`} style={{ "--c": colour(o), "--j": j } as CSSProperties}><i>{initials(o.name)}</i>{o.name.split(" ")[0]}</span>)}
                {reads.length > 6 && <em>+{reads.length - 6}</em>}
              </span>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="mvb">
      <div className="mvb-top">
        <p className="mvb-tip">{svg(<><path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20" /></>, 1.8)}
          <span>Drag people between the lists. Everyone always reads their own mailbox and their tickets' mail — only clients' mail.</span></p>
        {people.length > 10 && <input className="mvb-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a person…" aria-label="Find a person" />}
        <Saved state={state} />
      </div>
      {missing && <p className="pa2-warn"><span>Run <b>139_mail_clients_only.sql</b> in Supabase to save this.</span></p>}
      {err && !missing && <p className="pa2-warn"><span>{err}</span></p>}
      {!canEdit && <p className="psec-note">Only a Boss or a superadmin can change this.</p>}
      <div className={`mvb-lanes ${drag ? "is-dragging" : ""}`}>
        {LANES.map((l) => {
          const list = shown.filter((p) => laneOf(p) === l.k);
          return (
            <section key={l.k} className={`mvb-lane is-${l.k} ${over === l.k ? "is-over" : ""}`}
              onDragOver={(e) => { if (!drag) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (over !== l.k) setOver(l.k); }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((o) => (o === l.k ? null : o)); }}
              onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/plain") || drag; if (id) move(id, l.k); setDrag(null); setOver(null); }}>
              <header className="mvb-lane-h">
                <span className="mvb-lane-ico">{l.ico}</span>
                <span className="mvb-lane-t"><b>{l.title}</b><small>{l.hint}</small></span>
                <em>{list.length}</em>
              </header>
              <div className="mvb-cards">
                {list.map((p, i) => card(p, l.k, i))}
                <div className="mvb-drop">{list.length ? "Drop here" : "Drag people here"}</div>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- Settings › Tickets: the figures on top ---------- */
export function TicketsFigures() {
  const [f, setF] = useState<{ keep: "clients" | "crm"; clients: number; boxes: number; owners: number; rules: number } | null>(null);
  useEffect(() => {
    let alive = true;
    void Promise.all([
      loadRules(),
      supabase.from("clients").select("id", { count: "exact", head: true }),
      supabase.from("ticket_mailboxes").select("id, owner_id, active"),
    ]).then(([r, c, m]) => {
      if (!alive) return;
      const boxes = ((m.data ?? []) as any[]).filter((x) => x.active !== false);
      const rr = r.rules;
      setF({ keep: rr.keep, clients: c.count ?? 0, boxes: boxes.length, owners: new Set(boxes.map((x) => x.owner_id).filter(Boolean)).size,
        rules: (rr.everyone ? 1 : 0) + Object.keys(rr.depts).length + Object.keys(rr.roles).length + Object.keys(rr.users).length });
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const cards: { k: string; v: string; s: string; ico: ReactNode }[] = [
    { k: "Mail that comes in", v: f ? (f.keep === "crm" ? "Clients + CRM" : "Clients only") : "…", s: "Checked on arrival and every read",
      ico: svg(<><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>) },
    { k: "Clients", v: f ? String(f.clients) : "…", s: "Whose addresses and domains count", ico: svg(<><path d="M3 21h18" /><path d="M5 21V7l7-4 7 4v14" /><path d="M9 9h1M14 9h1M9 13h1M14 13h1" /></>) },
    { k: "Mailboxes", v: f ? String(f.boxes) : "…", s: f ? `${f.owners} personal · ${f.boxes - f.owners} shared` : "Connected", ico: svg(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>) },
    { k: "Mail rules", v: f ? String(f.rules) : "…", s: "Departments, roles, people", ico: svg(<><path d="M3 12s4-6 9-6 9 6 9 6-4 6-9 6-9-6-9-6z" /><circle cx="12" cy="12" r="2.6" /></>) },
  ];
  return (
    <div className="sxm-figs">
      {cards.map((c, i) => (
        <div key={c.k} className="sxm-fig" style={{ "--i": i } as CSSProperties} title={`${c.k}: ${c.v} — ${c.s}`}>
          <span className="sxm-fig-ico">{c.ico}</span>
          <span className="sxm-fig-t"><b className="sxm-fig-v">{c.v}</b><span className="sxm-fig-k">{c.k}</span></span>
        </div>
      ))}
    </div>
  );
}
