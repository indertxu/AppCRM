/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Home page.
 *
 *   homepage/
 *     HomePage.tsx          ← this: greeting + layout, picks the right home
 *     shared/               ← what everyone gets, in the left column
 *       HomeCalendar.tsx      next 5 working days · month · coming up
 *       HomeTodo.tsx          my to-do (tasks from Sales for now)
 *     sales/SalesHome.tsx         ← right side for the sales team
 *     consultancy/ConsultancyHome ← right side for consultancy
 *     management/ManagementHome   ← right side for the boss / managers
 *
 * Which right side you get goes by DEPARTMENT first (a boss inside
 * consultancy sees consultancy), then by role. Anyone else gets the shared
 * column on its own, spread across the page.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../api/supabase";
import { useAuth } from "../../api/AuthProvider";
import HomeCalendar from "./shared/HomeCalendar";
import HomeTodo, { TicketDesk, TicketDrawer, TicketDrawerById, TkIco, Avatar, loadDirectory, loadTicketTypes, ticketRef, stageLabel, TICKETS_EVENT, type Directory, type TicketStage } from "./shared/HomeTodo";
import SalesHome from "./sales/SalesHome";
import ConsultancyHome from "./consultancy/ConsultancyHome";
import ManagementHome from "./management/ManagementHome";
import { applyRolePreview } from "../../framework/SuperAdmin";
import "./HomePage.css";

const greeting = () => {
  const h = new Date().getHours();
  if (h < 6) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 19) return "Good afternoon";
  return "Good evening";
};

const NextLogo = () => (
  <svg viewBox="14 15 92 93" role="img" aria-label="Next">
    <g transform="matrix(1,0.5,-1,0.5,60,17)">
      <rect width="38" height="38" rx="2" fill="#86efc0" />
      <polyline points="7,30 15,19 22,24 31.7,10.1" fill="none" stroke="#0a6f4d" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      <polygon points="36,4 35.1,12.5 28.2,7.7" fill="#0a6f4d" />
    </g>
    <g transform="translate(16,47) skewY(26.565)"><rect width="38" height="40" rx="2" fill="#12b57f" /><text x="19" y="30" textAnchor="middle" fill="#fff" fontFamily="Arial" fontWeight="700" fontSize="27">N</text></g>
    <g transform="translate(66,66) skewY(-26.565)"><rect width="38" height="40" rx="2" fill="#0a6f4d" /><rect x="6" y="24" width="6" height="11" rx="1.5" fill="#fff" /><rect x="16" y="16" width="6" height="19" rx="1.5" fill="#fff" /><rect x="26" y="8" width="6" height="27" rx="1.5" fill="#fff" /></g>
  </svg>
);

const areaTitle = (a: Area) => a === "consultancy" ? "Consultancy" : a === "sales" ? "Sales" : a === "management" ? "Management" : "Next Management";

type Me = { id: string; department: string | null; role: string | null; firstName: string | null; isSuper: boolean };
type Area = "sales" | "consultancy" | "management" | null;

const SALES_ROLES = ["sales", "sales_manager"];
const MANAGER_ROLES = ["boss", "consultancy_manager", "sales_manager"];

function areaFor(me: Me | null, authRole: string | null): Area {
  if (!me) return null;
  const role = (me.role ?? authRole ?? "").toLowerCase();
  if (me.department === "consultancy") return "consultancy";
  if (me.department === "sales" || SALES_ROLES.includes(role)) return "sales";
  if (MANAGER_ROLES.includes(role) || me.isSuper) return "management";
  return null;
}

export default function HomePage() {
  const { role } = useAuth();
  const [uid, setUid] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [hoursPerDay, setHoursPerDay] = useState(8);

  useEffect(() => {
    let alive = true;
    (async () => {
      // Local session (no trip to the auth server, which would hold up every other query).
      const { data: s } = await supabase.auth.getSession();
      const uid = s?.session?.user?.id;
      if (!uid) return;
      setUid(uid); // the shared column only needs this — it starts loading straight away
      const [{ data: prof }, { data: bs }] = await Promise.all([
        supabase.from("profiles").select("id, department, role, first_name, is_superadmin").eq("id", uid).maybeSingle(),
        supabase.from("billing_settings").select("hours_per_day").eq("id", "default").maybeSingle(),
      ]);
      if (!alive) return;
      const p = prof ? applyRolePreview(prof as any) : null; // superadmin previewing a role
      setMe({ id: uid, department: p?.department ?? null, role: p?.role ?? role ?? null, firstName: p?.first_name ?? null, isSuper: p?.is_superadmin === true });
      setHoursPerDay(Number((bs as any)?.hours_per_day) || 8);
    })();
    return () => { alive = false; };
  }, [role]);

  const area = areaFor(me, role ?? null);
  const r = (me?.role ?? role ?? "").toLowerCase();
  const isLead = r === "boss" || r === "consultancy_manager";
  const seesSalesTeam = r === "boss" || r === "sales_manager" || !!me?.isSuper;

  return (
    <div className="home">
      <div className="home-flood" aria-hidden="true" />

      <header className="home-bar">
        <span className="home-logo-mini" aria-hidden="true"><NextLogo /></span>
        <div className="home-hello">
          <span className="home-eyebrow">{areaTitle(area)}</span>
          <h1 className="home-title">{greeting()}{me?.firstName ? <>, <em>{me.firstName}</em></> : ""}</h1>
        </div>
        <GlobalSearch />
        <span className="home-date">{new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</span>
      </header>

      {!uid ? (
        <div className="home-grid">
          <div className="home-side"><div className="home-ghost" /><div className="home-ghost is-short" /></div>
          <div className="home-main"><div className="home-ghost" /></div>
        </div>
      ) : me && area === "consultancy" ? (
        <ConsultancyHome userId={me.id} isLead={isLead} hoursPerDay={hoursPerDay}
          calendar={<HomeCalendar userId={uid} hoursPerDay={hoursPerDay} />}
          desk={<TicketDesk />} />
      ) : (
        <div className={`home-grid ${me && !area ? "is-solo" : ""}`}>
          <aside className="home-side">
            <HomeCalendar userId={uid} hoursPerDay={hoursPerDay} />
            <HomeTodo />
          </aside>
          {!me ? (
            <main className="home-main"><div className="home-ghost" /></main>
          ) : area && (
            <main className="home-main">
              {area === "sales" && <SalesHome userId={me.id} seesTeam={seesSalesTeam} />}
              {area === "management" && <ManagementHome />}
            </main>
          )}
        </div>
      )}
    </div>
  );
}

/* =====================================================================
   GLOBAL SEARCH — one box for everything: companies, contacts, clients,
   deals, projects, tickets and people. ⌘K / Ctrl K or "/" from anywhere on
   the page. Empty, it suggests: what you opened lately, your open tickets
   and your next meetings. Results are grouped by kind; ↑ ↓ Enter to open.
   ===================================================================== */
type HitKind = "client" | "company" | "contact" | "deal" | "project" | "ticket" | "person" | "meeting" | "action";
interface Hit { kind: HitKind; id: string; label: string; sub?: string; score?: number; stage?: TicketStage; extra?: any }
const KIND_LABEL: Record<HitKind, string> = { client: "Clients", company: "Companies", contact: "Contacts", deal: "Deals", project: "Projects", ticket: "Tickets", person: "People", meeting: "Up next", action: "Actions" };
const KIND_ONE: Record<HitKind, string> = { client: "Client", company: "Company", contact: "Contact", deal: "Deal", project: "Project", ticket: "Ticket", person: "Person", meeting: "Meeting", action: "" };
const KIND_ICON: Record<HitKind, "briefcase" | "building" | "user" | "deal" | "folder" | "inbox" | "clock" | "plus"> = {
  client: "briefcase", company: "building", contact: "user", deal: "deal", project: "folder", ticket: "inbox", person: "user", meeting: "clock", action: "plus",
};
const ORDER: HitKind[] = ["ticket", "client", "deal", "company", "contact", "project", "person"];
const RECENT_KEY = "home.search.recent";
const readRecent = (): Hit[] => { try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); return Array.isArray(v) ? v.slice(0, 6) : []; } catch { return []; } };
const pushRecent = (h: Hit) => {
  if (h.kind === "action" || h.kind === "meeting") return;
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([{ kind: h.kind, id: h.id, label: h.label, sub: h.sub }, ...readRecent().filter((x) => !(x.kind === h.kind && x.id === h.id))].slice(0, 6))); } catch { /* private mode */ }
};
const fold = (s: string) => (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
/** How well `text` answers `q`: whole start > a word start > anywhere (0 = no match). */
function scoreOf(text: string, q: string): number {
  const t = fold(text);
  if (!q || !t) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  if (new RegExp(`(^|[\\s@._\\-/(])${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(t)) return 60;
  if (t.includes(q)) return 35;
  // every word of the query somewhere
  const words = q.split(/\s+/).filter(Boolean);
  return words.length > 1 && words.every((w) => t.includes(w)) ? 25 : 0;
}
function Mark({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = fold(text).indexOf(q);
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

export function GlobalSearch() {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState<Directory | null>(null);
  const [tickets, setTickets] = useState<{ id: string; title: string; no: number | null; stage: TicketStage; due: string | null; assignee: string | null; active: boolean }[]>([]);
  const [meetings, setMeetings] = useState<Hit[]>([]);
  const [sel, setSel] = useState(0);
  const [recent, setRecent] = useState<Hit[]>([]);
  const [ticketOpen, setTicketOpen] = useState<string | null>(null);
  const [newTicket, setNewTicket] = useState<string | null>(null);
  const [types, setTypes] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);

  const loadAll = () => {
    loaded.current = true;
    loadDirectory().then(setDir).catch(() => {});
    loadTicketTypes().then(setTypes).catch(() => {});
    (async () => {
      let r: any = await supabase.from("tracking_tasks").select("id, title, ticket_no, stage, done, status, due_at, assignee_id").order("created_at", { ascending: false }).range(0, 4999);
      if (r.error) r = await supabase.from("tracking_tasks").select("id, title, done, status, due_at").order("created_at", { ascending: false }).range(0, 4999);
      setTickets(((r.data ?? []) as any[]).map((t) => {
        const stage: TicketStage = t.stage ?? (t.done || t.status === "done" ? "resolved" : t.status === "in_progress" ? "in_progress" : t.status === "blocked" ? "waiting" : "open");
        return { id: t.id, title: t.title ?? "", no: t.ticket_no ?? null, stage, due: t.due_at ?? null, assignee: t.assignee_id ?? null, active: !["resolved", "closed"].includes(stage) };
      }));
      const { data: s } = await supabase.auth.getSession();
      const me = s?.session?.user?.id;
      if (!me) return;
      const today = new Date(); const to = new Date(); to.setDate(to.getDate() + 14);
      const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const { data: ev } = await supabase.from("calendar_entries").select("id, entry_date, start_min, kind, title, notes").eq("user_id", me).eq("kind", "meeting").gte("entry_date", iso(today)).lte("entry_date", iso(to)).order("entry_date").limit(30);
      const nowMin = today.getHours() * 60 + today.getMinutes();
      setMeetings(((ev ?? []) as any[]).filter((e) => e.kind === "meeting" && (e.entry_date > iso(today) || (e.start_min ?? 0) >= nowMin))
        .sort((a, b) => a.entry_date.localeCompare(b.entry_date) || (a.start_min ?? 0) - (b.start_min ?? 0)).slice(0, 3)
        .map((e) => ({ kind: "meeting" as const, id: e.id, label: e.title || e.notes || "Meeting",
          sub: `${new Date(e.entry_date + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} · ${String(Math.floor((e.start_min ?? 0) / 60)).padStart(2, "0")}:${String((e.start_min ?? 0) % 60).padStart(2, "0")}` })));
    })().catch(() => {});
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = /input|textarea|select/i.test((e.target as HTMLElement)?.tagName ?? "") || (e.target as HTMLElement)?.isContentEditable;
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) { e.preventDefault(); inputRef.current?.focus(); }
    };
    const down = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    const changed = () => { if (loaded.current) loadAll(); };
    document.addEventListener("keydown", key);
    document.addEventListener("mousedown", down);
    window.addEventListener(TICKETS_EVENT, changed);
    return () => { document.removeEventListener("keydown", key); document.removeEventListener("mousedown", down); window.removeEventListener(TICKETS_EVENT, changed); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fq = fold(q.trim());
  const sections = useMemo((): { kind: HitKind; title: string; hits: Hit[] }[] => {
    const me = dir?.me ?? null;
    const coName = new Map((dir?.companies ?? []).map((c) => [c.id, c.name]));
    const clName = new Map((dir?.clients ?? []).map((c) => [c.id, c.name]));
    if (!fq) {
      const mine = tickets.filter((t) => t.active && t.assignee === me).sort((a, b) => (a.due ?? "9").localeCompare(b.due ?? "9")).slice(0, 4)
        .map((t) => ({ kind: "ticket" as const, id: t.id, label: t.title, sub: `${ticketRef(t)} · ${stageLabel(t.stage)}${t.due ? ` · due ${new Date(t.due).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}`, stage: t.stage }));
      const out: { kind: HitKind; title: string; hits: Hit[] }[] = [];
      if (recent.length) out.push({ kind: "client", title: "Recent", hits: recent });
      if (mine.length) out.push({ kind: "ticket", title: "Your open tickets", hits: mine });
      if (meetings.length) out.push({ kind: "meeting", title: "Up next", hits: meetings });
      return out;
    }
    const all: Hit[] = [];
    const add = (kind: HitKind, id: string, label: string, sub: string | undefined, texts: string[], boost = 0, extra?: any) => {
      const sc = Math.max(...texts.map((t) => scoreOf(t, fq)));
      if (sc > 0) all.push({ kind, id, label, sub, score: sc + boost, extra });
    };
    tickets.forEach((t) => add("ticket", t.id, t.title, `${ticketRef(t)} · ${stageLabel(t.stage)}`, [t.title, ticketRef(t), t.no ? String(t.no) : ""], t.active ? 4 : -10, t));
    (dir?.clients ?? []).forEach((c) => add("client", c.id, c.name, "Client", [c.name], 6));
    (dir?.deals ?? []).forEach((d) => add("deal", d.id, d.name, [d.companyId ? coName.get(d.companyId) : null, d.status].filter(Boolean).join(" · ") || "Deal", [d.name, d.companyId ? coName.get(d.companyId) ?? "" : ""], d.status === "active" ? 3 : 0));
    (dir?.companies ?? []).forEach((c) => add("company", c.id, c.name, c.legal && c.legal !== c.name ? c.legal : "Company", [c.name, c.legal ?? ""]));
    (dir?.contacts ?? []).forEach((c) => add("contact", c.id, c.name, [c.title, c.email].filter(Boolean).join(" · ") || "Contact", [c.name, c.email ?? ""]));
    (dir?.projects ?? []).forEach((p) => add("project", p.id, p.name, p.clientId ? clName.get(p.clientId) : "Project", [p.name, p.clientId ? clName.get(p.clientId) ?? "" : ""], 0, p));
    (dir?.people ?? []).forEach((p) => add("person", p.id, p.name, [p.department, p.email].filter(Boolean).join(" · "), [p.name, p.email], -2));
    const best = [...all].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const out: { kind: HitKind; title: string; hits: Hit[] }[] = [];
    if (best[0] && (best[0].score ?? 0) >= 60) out.push({ kind: best[0].kind, title: "Top hit", hits: [best[0]] });
    ORDER.forEach((k) => {
      const hits = best.filter((h) => h.kind === k && h !== out[0]?.hits[0]).slice(0, k === "ticket" ? 4 : 3);
      if (hits.length) out.push({ kind: k, title: KIND_LABEL[k], hits });
    });
    out.push({ kind: "action", title: "Actions", hits: [{ kind: "action", id: "new-ticket", label: `Log a ticket: “${q.trim()}”`, sub: "Lands on your desk" }] });
    return out;
  }, [fq, q, dir, tickets, meetings, recent]);
  const flat = sections.flatMap((s) => s.hits);
  useEffect(() => { setSel(0); }, [fq]);

  const go = (h: Hit) => {
    pushRecent(h);
    setOpen(false); setQ("");
    inputRef.current?.blur();
    switch (h.kind) {
      case "company": nav("/companies", { state: { focusCompanyId: h.id } }); break;
      case "contact": nav("/contacts", { state: { focusContactId: h.id } }); break;
      case "client": nav(`/clients?client=${h.id}`); break;
      case "deal": nav(`/sales?tracking=${h.id}`); break;
      case "project": { const p = dir?.projects.find((x) => x.id === h.id); nav(p?.clientId ? `/clients?client=${p.clientId}` : "/projects"); break; }
      case "ticket": setTicketOpen(h.id); break;
      case "meeting": nav("/calendar"); break;
      case "person": { const p = dir?.people.find((x) => x.id === h.id); if (p?.email) window.location.href = `mailto:${p.email}`; break; }
      case "action": setNewTicket(q.trim()); break;
    }
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => Math.min(flat.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { const h = flat[sel]; if (h) go(h); }
    else if (e.key === "Escape") { setOpen(false); inputRef.current?.blur(); }
  };
  const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
  let idx = -1;
  const loading = open && !dir;

  return (
    <div className={`gs ${open ? "is-open" : ""}`} ref={boxRef}>
      <div className="gs-box" onClick={() => inputRef.current?.focus()}>
        <TkIco d="search" className="gs-ico" />
        <input ref={inputRef} value={q} placeholder="Search anything — clients, deals, contacts, tickets…" aria-label="Search everything"
          onFocus={() => { setOpen(true); setRecent(readRecent()); if (!loaded.current) loadAll(); }}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }} onKeyDown={onKey} />
        {q ? <button type="button" className="gs-clear" onClick={() => { setQ(""); inputRef.current?.focus(); }} aria-label="Clear"><TkIco d="x" /></button>
          : <kbd className="gs-kbd">{isMac ? "⌘" : "Ctrl"} K</kbd>}
      </div>
      {open && (
        <div className="gs-panel" role="listbox">
          {loading ? <div className="gs-loading"><span className="gs-spin" />Loading everything…</div>
            : !sections.length ? <p className="gs-empty">Start typing to search clients, deals, companies, contacts, projects, tickets and people.</p>
            : sections.map((s, si) => (
              <div className="gs-sec" key={`${s.title}-${si}`}>
                <span className="gs-sec-h">{s.title}</span>
                {s.hits.map((h) => {
                  idx += 1;
                  const i = idx;
                  const person = h.kind === "person" ? dir?.people.find((p) => p.id === h.id) : null;
                  return (
                    <button type="button" key={`${h.kind}-${h.id}`} className={`gs-hit is-${h.kind} ${i === sel ? "is-sel" : ""}`} role="option" aria-selected={i === sel}
                      onMouseEnter={() => setSel(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => go(h)}>
                      {person ? <Avatar person={person} size={30} /> : <span className="gs-hit-ico"><TkIco d={KIND_ICON[h.kind]} /></span>}
                      <span className="gs-hit-txt">
                        <b><Mark text={h.label} q={fq} /></b>
                        {h.sub && <em>{h.sub}</em>}
                      </span>
                      {h.kind !== "action" && <span className="gs-hit-kind">{KIND_ONE[h.kind]}</span>}
                      <span className="gs-hit-go" aria-hidden="true">↵</span>
                    </button>
                  );
                })}
              </div>
            ))}
          {!loading && fq && flat.length <= 1 && <p className="gs-empty">Nothing found for “{q.trim()}”.</p>}
          <div className="gs-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div>
        </div>
      )}
      {ticketOpen && <TicketDrawerById id={ticketOpen} onClose={() => setTicketOpen(null)} />}
      {newTicket !== null && dir && (
        <TicketDrawer ticket={null} draft={{ title: newTicket, assignee: dir.me }} dir={dir} types={types.length ? types : ["Request"]} ready={tickets.length === 0 || tickets.some((t) => t.no != null)}
          onClose={() => setNewTicket(null)} onCreated={(id) => { setNewTicket(null); setTicketOpen(id); }} />
      )}
    </div>
  );
}
