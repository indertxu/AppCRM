/* =====================================================================
   Calendar › Marketing: the megaphone next to the other calendars switches the Calendar
   (and the Sales calendar) from your work to marketing — the e-mail campaigns and the
   social posts of the company, on the same week or month, read straight from
   marketing_campaigns / marketing_posts (Marketing › Calendar shows the same).
   A card opens a preview; "Open in Marketing" lands on that campaign or post
   (sessionStorage "mk-open", read by MarketingPage in contacts/ContactExport.tsx).
   For now everyone sees the switch; who may see it comes later.
   ===================================================================== */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { createPortal, flushSync } from "react-dom";
import { supabase } from "../../api/supabase";
import { BRANDS } from "../settings/integrations/brandIcons";
import "./CalendarMarketing.css";

const MK_KEY = "cal.marketing";
const SHOW_KEY = "cal.marketing.show";

/* ---------- the networks: their colour and logo ---------- */
const NETS: Record<string, { label: string; color: string; brand?: string; short: string }> = {
  linkedin: { label: "LinkedIn", color: "#0a66c2", brand: "linkedin", short: "in" },
  instagram: { label: "Instagram", color: "#e1306c", brand: "instagram", short: "IG" },
  facebook: { label: "Facebook", color: "#1877f2", brand: "facebook", short: "f" },
  x: { label: "X", color: "#14171a", brand: "x", short: "X" },
  tiktok: { label: "TikTok", color: "#111111", brand: "tiktok", short: "TT" },
  threads: { label: "Threads", color: "#3d3d3d", short: "@" },
  youtube: { label: "YouTube", color: "#e62117", brand: "youtube", short: "YT" },
};
const MAIL_C = "#0c875f";
const netOf = (n: string) => NETS[n] ?? { label: n, color: "#5d6a64", short: n.slice(0, 2).toUpperCase() };

/** A network's logo in its colour (white on the colour when `solid`), or the e-mail mark. */
export function MkMark({ kind, net, size = 22, solid = false }: { kind: "email" | "post"; net?: string; size?: number; solid?: boolean }) {
  const m = kind === "email" ? null : netOf(net ?? "linkedin");
  const brand = m?.brand ? BRANDS[m.brand] : null;
  const c = m ? m.color : MAIL_C;
  return (
    <i className={`cmk-mark ${solid ? "is-solid" : ""}`} style={{ ["--c" as string]: c, width: size, height: size } as CSSProperties} title={m ? m.label : "E-mail"} aria-label={m ? m.label : "E-mail"}>
      {kind === "email" ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M3.5 6.5l8.5 6.5 8.5-6.5" /></svg>
      ) : brand ? (
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d={brand.path} fill="currentColor" /></svg>
      ) : (
        <b>{m!.short}</b>
      )}
    </i>
  );
}

/* ---------- the data ---------- */
export interface MkCalItem {
  key: string; id: string; kind: "email" | "post"; t: number; title: string; sub: string; status: string;
  nets: string[]; img?: string; text?: string; subject?: string; listName?: string;
  sent?: number; total?: number; results?: { likes: number; comments: number; shares: number; impressions: number }; url?: string;
}
export const MK_STATUS: Record<string, string> = {
  due: "Ready now", scheduled: "Scheduled", draft: "Draft", idea: "Idea", published: "Published", failed: "Failed",
  sent: "Sent", sending: "Sending", paused: "Paused", cancelled: "Cancelled",
};
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const hm = (t: number) => new Date(t).toTimeString().slice(0, 5);
const monday = (d: Date) => { const m = new Date(d.getFullYear(), d.getMonth(), d.getDate()); m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); return m; };
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

type Loaded = { items: MkCalItem[]; upcoming: MkCalItem[]; unplanned: MkCalItem[]; missing: boolean; error: string | null };
const CAMP_COLS = "id, name, subject, status, scheduled_at, started_at, list_id, stats";
const POST_COLS = "id, title, body, networks, media, link_preview, link_url, status, scheduled_at, published_at, results, updated_at";
const campAt = (x: any) => (x.status === "scheduled" || x.status === "draft" ? x.scheduled_at : x.started_at ?? x.scheduled_at);
const postAt = (x: any) => (x.status === "published" ? x.published_at ?? x.scheduled_at : x.scheduled_at);
function campItem(x: any, lists: Map<string, string>): MkCalItem {
  const at = campAt(x), t = at ? new Date(at).getTime() : NaN;
  const st = x.stats ?? {};
  const listName = x.list_id ? lists.get(x.list_id) : undefined;
  const sent = Number(st.sent ?? 0), total = Number(st.total ?? 0);
  return {
    key: `c-${x.id}`, id: x.id, kind: "email", t, title: x.name || x.subject || "E-mail campaign", status: x.status,
    sub: [listName ? `To ${listName}` : "E-mail", total ? `${sent.toLocaleString()} of ${total.toLocaleString()} sent` : ""].filter(Boolean).join(" · "),
    nets: [], subject: x.subject || undefined, listName, sent, total,
  };
}
function postItem(x: any, now: number): MkCalItem {
  const at = postAt(x), t = at ? new Date(at).getTime() : NaN;
  const nets: string[] = Array.isArray(x.networks) && x.networks.length ? x.networks : ["linkedin"];
  const media: any[] = Array.isArray(x.media) ? x.media : [];
  const img = media.find((m) => m?.kind === "image")?.url ?? x.link_preview?.image ?? undefined;
  const body = String(x.body ?? "");
  const res = x.results && typeof x.results === "object" ? Object.values(x.results as Record<string, any>) : [];
  const sum = (k: string) => res.reduce((s0, r) => s0 + (Number(r?.[k]) || 0), 0);
  const url = res.map((r) => r?.url).find(Boolean) as string | undefined;
  return {
    key: `p-${x.id}`, id: x.id, kind: "post", t, nets, img: img || undefined, text: x.title ? body : body.split("\n").slice(1).join("\n").trim(),
    title: x.title || body.split("\n")[0].slice(0, 90) || "Post",
    status: x.status === "scheduled" && t <= now ? "due" : x.status,
    sub: nets.map((n) => netOf(n).label).join(", "),
    results: res.length ? { likes: sum("likes"), comments: sum("comments"), shares: sum("shares"), impressions: sum("impressions") } : undefined, url,
  };
}

async function loadItems(from: Date, to: Date): Promise<Loaded> {
  const a = from.toISOString(), b = to.toISOString();
  const now = Date.now(), soon = new Date(now - 3600e3).toISOString();
  const inRange = (col: string) => `and(${col}.gte.${a},${col}.lt.${b})`;
  const [c, p, cu, pu, un] = await Promise.all([
    supabase.from("marketing_campaigns").select(CAMP_COLS).or(`${inRange("scheduled_at")},${inRange("started_at")}`).limit(500),
    supabase.from("marketing_posts").select(POST_COLS).neq("status", "cancelled").or(`${inRange("scheduled_at")},${inRange("published_at")}`).limit(1000),
    // what's coming, wherever it falls: the next e-mails and posts from now on
    supabase.from("marketing_campaigns").select(CAMP_COLS).in("status", ["scheduled", "draft"]).gte("scheduled_at", soon).order("scheduled_at").limit(10),
    supabase.from("marketing_posts").select(POST_COLS).in("status", ["scheduled", "draft", "idea", "failed"]).gte("scheduled_at", soon).order("scheduled_at").limit(10),
    // drafts and ideas with no day yet
    supabase.from("marketing_posts").select(POST_COLS).is("scheduled_at", null).in("status", ["draft", "idea"]).order("updated_at", { ascending: false }).limit(40),
  ]);
  const err = c.error ?? p.error;
  if (err && !c.data && !p.data) {
    const missing = /does not exist|schema cache|relation/i.test(err.message ?? "");
    return { items: [], upcoming: [], unplanned: [], missing, error: missing ? null : err.message };
  }
  const camps = ((c.data ?? []) as any[]).filter((x) => x.status !== "cancelled");
  const campsUp = ((cu.data ?? []) as any[]).filter((x) => (x.status === "scheduled" || x.status === "draft") && x.scheduled_at && new Date(x.scheduled_at).getTime() >= now - 3600e3);
  const listIds = [...new Set([...camps, ...campsUp].map((x) => x.list_id).filter(Boolean))];
  const lists = new Map<string, string>();
  if (listIds.length) {
    const { data } = await supabase.from("marketing_lists").select("id, name").in("id", listIds);
    ((data ?? []) as any[]).forEach((l) => lists.set(l.id, l.name));
  }
  const t0 = from.getTime(), t1 = to.getTime();
  const items: MkCalItem[] = [
    ...camps.map((x) => campItem(x, lists)),
    ...((p.data ?? []) as any[]).filter((x) => x.status !== "cancelled").map((x) => postItem(x, now)),
  ].filter((it) => it.t >= t0 && it.t < t1).sort((x, y) => x.t - y.t);
  const upcoming: MkCalItem[] = [
    ...campsUp.map((x) => campItem(x, lists)),
    ...((pu.data ?? []) as any[]).filter((x) => ["scheduled", "draft", "idea", "failed"].includes(x.status)).map((x) => postItem(x, now)),
  ].filter((it) => it.t >= now - 3600e3).sort((x, y) => x.t - y.t).slice(0, 8);
  const unplanned = ((un.data ?? []) as any[]).filter((x) => !x.scheduled_at && (x.status === "draft" || x.status === "idea")).map((x) => postItem(x, now));
  return { items, upcoming, unplanned, missing: false, error: null };
}

/** A post onto a day: its time stays (09:00 when it had none); drafts and ideas stay what they are. */
async function movePost(id: string, day: string, keepTime: number, status: string): Promise<string | null> {
  const hhmm = Number.isFinite(keepTime) ? hm(keepTime) : "09:00";
  const at = new Date(`${day}T${hhmm}:00`).toISOString();
  const next = status === "idea" || status === "draft" ? status : "scheduled";
  const { error } = await supabase.from("marketing_posts").update({ scheduled_at: at, status: next, updated_at: new Date().toISOString() }).eq("id", id);
  return error ? error.message : null;
}

/** The marketing switch, its filters and the items of the days on screen. */
export function useCalendarMarketing(view: "week" | "month", weekStart: Date, monthAnchor: Date) {
  const [on, setOnRaw] = useState<boolean>(() => { try { return localStorage.getItem(MK_KEY) === "1"; } catch { return false; } });
  // the switch morphs one calendar into the other (View Transitions where the browser has them; CalendarMarketing.css)
  const setOn = (v: boolean) => {
    const apply = () => { setOnRaw(v); try { localStorage.setItem(MK_KEY, v ? "1" : "0"); } catch { /* private mode */ } };
    const d = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (d.startViewTransition && !calm) {
      document.documentElement.classList.add(v ? "cmk-vt-to-mk" : "cmk-vt-to-work");
      const t = d.startViewTransition(() => { flushSync(apply); }) as { finished?: Promise<void> } | undefined;
      const done = () => document.documentElement.classList.remove("cmk-vt-to-mk", "cmk-vt-to-work");
      if (t?.finished) t.finished.then(done, done); else window.setTimeout(done, 800);
    } else apply();
  };
  const [show, setShowRaw] = useState<{ email: boolean; post: boolean }>(() => {
    try { const s = JSON.parse(localStorage.getItem(SHOW_KEY) || "{}"); return { email: s.email !== false, post: s.post !== false }; } catch { return { email: true, post: true }; }
  });
  const setShow = (s: { email: boolean; post: boolean }) => { setShowRaw(s); try { localStorage.setItem(SHOW_KEY, JSON.stringify(s)); } catch { /* private mode */ } };
  const from = view === "month" ? monday(new Date(monthAnchor.getFullYear(), monthAnchor.getMonth(), 1)) : monday(weekStart);
  const to = addDays(from, view === "month" ? 42 : 7);
  const [state, setState] = useState<({ key: string } & Loaded) | null>(null);
  const [tick, setTick] = useState(0);
  const key = `${from.getTime()}-${to.getTime()}-${tick}`;
  // read while it's on; while it's off, read quietly a moment after the days change, so the switch opens instantly
  useEffect(() => {
    if (state?.key === key) return;
    let alive = true;
    const run = () => loadItems(from, to).then((r) => { if (alive) setState({ key, ...r }); }).catch((e) => { if (alive) setState({ key, items: [], upcoming: [], unplanned: [], missing: false, error: String(e?.message ?? e) }); });
    const timer = on ? (void run(), 0) : window.setTimeout(run, 1200);
    return () => { alive = false; if (timer) window.clearTimeout(timer); };
  }, [on, key]); // eslint-disable-line react-hooks/exhaustive-deps
  // back on the tab: fresh figures (a post may have gone out meanwhile)
  useEffect(() => {
    if (!on) return;
    const vis = () => { if (document.visibilityState === "visible") setTick((n) => n + 1); };
    document.addEventListener("visibilitychange", vis);
    return () => document.removeEventListener("visibilitychange", vis);
  }, [on]);
  const all = state?.items ?? [];
  const shown = (it: MkCalItem) => (it.kind === "email" ? show.email : show.post);
  const items = all.filter(shown);
  // the side column (Up next · Not planned yet), open or folded to a rail
  const [side, setSideRaw] = useState<boolean>(() => { try { return localStorage.getItem("cal.marketing.side") !== "0"; } catch { return true; } });
  const setSide = (v: boolean) => { setSideRaw(v); try { localStorage.setItem("cal.marketing.side", v ? "1" : "0"); } catch { /* private mode */ } };
  // a post dragged onto a day: it moves at once, then the figures are read again
  const move = async (it: MkCalItem, day: string): Promise<string | null> => {
    const patch = (x: MkCalItem): MkCalItem => {
      const hhmm = Number.isFinite(x.t) ? hm(x.t) : "09:00";
      const t = new Date(`${day}T${hhmm}:00`).getTime();
      return { ...x, t, status: x.status === "idea" || x.status === "draft" ? x.status : t <= Date.now() ? "due" : "scheduled" };
    };
    setState((st) => {
      if (!st) return st;
      const moved = patch(it);
      const inRange = moved.t >= from.getTime() && moved.t < to.getTime();
      return {
        ...st,
        items: [...st.items.filter((x) => x.key !== it.key), ...(inRange ? [moved] : [])].sort((x, y) => x.t - y.t),
        unplanned: st.unplanned.filter((x) => x.key !== it.key),
      };
    });
    const err = await movePost(it.id, day, it.t, it.status);
    setTick((n) => n + 1);
    return err;
  };
  return {
    on, setOn, show, setShow, from, to, all, items, side, setSide, move,
    upcoming: (state?.upcoming ?? []).filter(shown), unplanned: show.post ? state?.unplanned ?? [] : [],
    loading: on && state?.key !== key && !state, refreshing: on && !!state && state.key !== key,
    missing: !!state?.missing, error: state?.error ?? null, reload: () => setTick((n) => n + 1),
  };
}
export type CalendarMarketingState = ReturnType<typeof useCalendarMarketing>;

/** Open Marketing on a campaign, a post, or a new post on a day. */
export type MkOpen = { kind: "email" | "post" | "new" | "new-email" | "ai"; id?: string; day?: string; nets?: string[] };
function useOpenInMarketing() {
  const navigate = useNavigate();
  return (o: MkOpen) => {
    // back here once the post or e-mail is closed
    try { sessionStorage.setItem("mk-open", JSON.stringify({ ...o, back: window.location.pathname })); } catch { /* private mode: lands on Marketing anyway */ }
    navigate("/marketing");
  };
}

/* ---------- the header: the switch and the figures ---------- */
const MEGAPHONE = "M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13";
/** The round button next to the other calendars. */
export function MarketingSwitch({ mk }: { mk: CalendarMarketingState }) {
  return (
    <button type="button" className={`cal-gear cmk-switch ${mk.on ? "is-on" : ""}`} aria-pressed={mk.on}
      onClick={() => mk.setOn(!mk.on)}
      title={mk.on ? "Back to your calendar" : "Marketing calendar — the e-mails and posts"} aria-label={mk.on ? "Back to your calendar" : "Show the marketing calendar"}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={MEGAPHONE} /></svg>
    </button>
  );
}
/** In place of the billing figures while marketing is on: what's planned, what to show. */
export function MarketingStats({ mk, view }: { mk: CalendarMarketingState; view: "week" | "month" }) {
  const n = (k: "email" | "post") => mk.all.filter((it) => it.kind === k).length;
  const when = view === "month" ? "this month" : "this week";
  const chip = (k: "email" | "post", label: string, one: string) => {
    const on = mk.show[k], c = n(k);
    return (
      <button type="button" className={`cmk-chip is-${k} ${on ? "is-on" : ""}`} aria-pressed={on}
        title={on ? `Hide the ${label.toLowerCase()} ${when}` : `Show the ${label.toLowerCase()} ${when}`}
        onClick={() => mk.setShow({ ...mk.show, [k]: !on })}>
        <i className="cmk-chip-dot" />
        <b>{c}</b><span>{c === 1 ? one : label}</span>
      </button>
    );
  };
  return (
    <div className="cv-stats cmk-stats">
      {chip("email", "E-mails", "E-mail")}
      {chip("post", "Posts", "Post")}
      <MarketingNew />
    </div>
  );
}
/** "New ▾": a social post, a LinkedIn post or an e-mail campaign — straight into Marketing's editor, and back here after. */
export function MarketingNew({ day, label = "New" }: { day?: string; label?: string }) {
  const open = useOpenInMarketing();
  const [on, setOnRaw] = useState<DOMRect | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const setOn = (v: boolean | ((x: boolean) => boolean)) => {
    const want = typeof v === "function" ? v(!!on) : v;
    setOnRaw(want && ref.current ? ref.current.getBoundingClientRect() : null);
  };
  useEffect(() => {
    if (!on) return;
    const down = (e: MouseEvent) => { const t = e.target as Node; if (!ref.current?.contains(t) && !menuRef.current?.contains(t)) setOn(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOn(false); };
    const away = () => setOn(false);
    document.addEventListener("mousedown", down); document.addEventListener("keydown", key); window.addEventListener("resize", away);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); window.removeEventListener("resize", away); };
  }, [on]); // eslint-disable-line react-hooks/exhaustive-deps
  const items: { k: string; ico: React.ReactNode; t: string; hint: string; go: () => void }[] = [
    { k: "post", ico: <span className="cmk-new-stack"><MkMark kind="post" net="instagram" size={20} solid /><MkMark kind="post" net="facebook" size={20} solid /><MkMark kind="post" net="x" size={20} solid /></span>, t: "Social post", hint: "Instagram, Facebook, X… — pick the networks", go: () => open({ kind: "new", day, nets: [] }) },
    { k: "li", ico: <MkMark kind="post" net="linkedin" size={34} solid />, t: "LinkedIn post", hint: "Only on LinkedIn — your profile or page", go: () => open({ kind: "new", day, nets: ["linkedin"] }) },
    { k: "mail", ico: <MkMark kind="email" size={34} solid />, t: "E-mail campaign", hint: "Write it, pick a list, track who opens", go: () => open({ kind: "new-email" }) },
  ];
  return (
    <div className="cmk-new" ref={ref}>
      <button type="button" className={`cmk-go ${on ? "is-open" : ""}`} onClick={() => setOn((v) => !v)} aria-haspopup="menu" aria-expanded={!!on} title="New post or e-mail">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        <span>{label}</span>
        <svg className="cmk-go-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {on && createPortal(
        <div className="cmk-new-menu" role="menu" ref={menuRef}
          style={{ top: on.bottom + 10, left: Math.max(16, Math.min(on.right - 316, window.innerWidth - 332)) }}>
          {items.map((it, i) => (
            <button key={it.k} type="button" role="menuitem" className={`cmk-new-item is-${it.k}`} style={{ ["--i" as string]: i } as CSSProperties} onClick={() => { setOn(false); it.go(); }}>
              <span className="cmk-new-ico">{it.ico}</span>
              <span className="cmk-new-t"><b>{it.t}</b><em>{it.hint}</em></span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

/* ---------- a list that scrolls without a bar: soft edges + "↓ 2 more" ---------- */
function ScrollList({ className, children, count = true }: { className: string; children: React.ReactNode; count?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [hint, setHint] = useState<{ up: boolean; down: boolean; more: number }>({ up: false, down: false, more: 0 });
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const measure = () => {
      const top = el.scrollTop, bottom = top + el.clientHeight;
      const down = el.scrollHeight - bottom > 4;
      let more = 0;
      if (count && down) el.querySelectorAll<HTMLElement>(".cmk-card").forEach((c) => { if (c.offsetTop + c.offsetHeight / 2 > bottom) more++; });
      setHint((h) => (h.up === top > 4 && h.down === down && h.more === more ? h : { up: top > 4, down, more }));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    Array.from(el.children).forEach((c) => ro.observe(c));
    return () => { el.removeEventListener("scroll", measure); ro.disconnect(); };
  }, [children, count]);
  const down = () => { const el = ref.current; if (el) el.scrollBy({ top: Math.max(120, el.clientHeight * 0.75), behavior: "smooth" }); };
  return (
    <div className={`cmk-scroll ${hint.up ? "is-up" : ""} ${hint.down ? "is-down" : ""}`}>
      <div ref={ref} className={`${className} cmk-nobar`}>{children}</div>
      {count && hint.down && (
        <button type="button" className="cmk-more-down" onClick={down} tabIndex={-1} title="See the rest of the day">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
          <span>{hint.more > 0 ? `${hint.more} more` : "More"}</span>
        </button>
      )}
    </div>
  );
}

/* ---------- the calendar itself ---------- */
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Posts that can move to another day by dragging (not what already went out). */
const movable = (it: MkCalItem) => it.kind === "post" && it.status !== "published";
type Drag = { start: (it: MkCalItem) => void; end: () => void; item: MkCalItem | null };

function MkCard({ it, onOpen, drag, compact = false }: { it: MkCalItem; onOpen: (it: MkCalItem, r: DOMRect) => void; drag?: Drag; compact?: boolean }) {
  const lead = it.kind === "email" ? MAIL_C : netOf(it.nets[0]).color;
  const can = !!drag && movable(it);
  return (
    <button type="button" className={`cmk-card is-${it.kind} is-st-${it.status} ${it.img && !compact ? "has-img" : ""} ${can ? "is-drag" : ""} ${drag?.item?.key === it.key ? "is-dragging" : ""}`}
      style={{ ["--c" as string]: lead } as CSSProperties} title={`${hm(it.t)} · ${it.title}`}
      draggable={can || undefined}
      onDragStart={can ? (e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", it.key); drag!.start(it); } : undefined}
      onDragEnd={can ? () => drag!.end() : undefined}
      onClick={(e) => onOpen(it, e.currentTarget.getBoundingClientRect())}>
      {it.img && !compact && (
        <span className="cmk-card-img"><img src={it.img} alt="" loading="lazy" onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = "none"; }} /></span>
      )}
      <span className="cmk-card-top">
        <MkMark kind={it.kind} net={it.nets[0]} size={22} solid />
        {it.nets.length > 1 && <span className="cmk-card-more">{it.nets.slice(1, 4).map((n) => <MkMark key={n} kind="post" net={n} size={18} solid />)}</span>}
        <em>{hm(it.t)}</em>
      </span>
      <b className="cmk-card-t">{it.title}</b>
      {it.sub && <span className="cmk-card-sub">{it.sub.split(" · ").map((part, i) => <span key={i}>{i > 0 && " · "}{part}</span>)}</span>}
      <small className={`cmk-st is-${it.status}`}><i />{MK_STATUS[it.status] ?? it.status}</small>
    </button>
  );
}

/** A campaign or post, larger: opened from a card. */
function MkPeek({ it, from, onClose }: { it: MkCalItem; from: DOMRect; onClose: () => void }) {
  const open = useOpenInMarketing();
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    let left = from.right + 12;
    if (left + w > vw - 16) left = from.left - w - 12;
    if (left < 16) left = Math.max(16, Math.min(vw - w - 16, from.left + from.width / 2 - w / 2));
    const top = Math.max(16, Math.min(from.top - 8, vh - h - 16));
    setPos({ left, top });
  }, [from]);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const t = window.setTimeout(() => document.addEventListener("mousedown", down), 0);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", onClose);
    return () => { window.clearTimeout(t); document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); window.removeEventListener("resize", onClose); };
  }, [onClose]);
  const d = new Date(it.t);
  const lead = it.kind === "email" ? MAIL_C : netOf(it.nets[0]).color;
  const r = it.results;
  return (
    <div className="cmk-peek" ref={ref} role="dialog" aria-label={it.title}
      style={{ ["--c" as string]: lead, left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? "visible" : "hidden" } as CSSProperties}>
      <header className="cmk-peek-h">
        <MkMark kind={it.kind} net={it.nets[0]} size={34} solid />
        <span className="cmk-peek-when">
          <b>{it.kind === "email" ? "E-mail campaign" : it.nets.map((n) => netOf(n).label).join(" · ")}</b>
          <em>{Number.isFinite(it.t) ? `${d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })} · ${hm(it.t)}` : "Not planned yet — no day"}</em>
        </span>
        <button type="button" className="cmk-peek-x" onClick={onClose} aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </header>
      {it.img && <span className="cmk-peek-img"><img src={it.img} alt="" onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = "none"; }} /></span>}
      <ScrollList className="cmk-peek-body" count={false}>
        <small className={`cmk-st is-${it.status}`}><i />{MK_STATUS[it.status] ?? it.status}</small>
        <h4>{it.title}</h4>
        {it.kind === "email" ? (
          <>
            {it.subject && it.subject !== it.title && <p className="cmk-peek-subj"><em>Subject</em>{it.subject}</p>}
            <ul className="cmk-peek-facts">
              <li><em>To</em><b>{it.listName ?? "—"}</b></li>
              {!!it.total && <li><em>Sent</em><b>{(it.sent ?? 0).toLocaleString()} <i>of {it.total.toLocaleString()}</i></b></li>}
            </ul>
          </>
        ) : (
          <>
            {it.text && <p className="cmk-peek-text">{it.text.length > 320 ? `${it.text.slice(0, 320).trimEnd()}…` : it.text}</p>}
            {r && (r.likes + r.comments + r.shares + r.impressions > 0) && (
              <ul className="cmk-peek-facts is-results">
                {r.impressions > 0 && <li><em>Views</em><b>{r.impressions.toLocaleString()}</b></li>}
                <li><em>Likes</em><b>{r.likes.toLocaleString()}</b></li>
                <li><em>Comments</em><b>{r.comments.toLocaleString()}</b></li>
                {r.shares > 0 && <li><em>Shares</em><b>{r.shares.toLocaleString()}</b></li>}
              </ul>
            )}
          </>
        )}
      </ScrollList>
      <footer className="cmk-peek-f">
        {it.url && <a className="cmk-peek-link" href={it.url} target="_blank" rel="noopener noreferrer">See it live</a>}
        <button type="button" className="cmk-peek-open" onClick={() => open({ kind: it.kind, id: it.id })}>
          Open in Marketing
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        </button>
      </footer>
    </div>
  );
}

/** The week (seven days, Monday first) or the month, with the e-mails and posts on it. */
export function MarketingCalendar({ mk, view, weekStart, monthAnchor, onOpenWeek }: {
  mk: CalendarMarketingState; view: "week" | "month"; weekStart: Date; monthAnchor: Date; onOpenWeek?: (d: Date) => void;
}) {
  const open = useOpenInMarketing();
  const [peek, setPeek] = useState<{ it: MkCalItem; from: DOMRect } | null>(null);
  useEffect(() => { setPeek(null); }, [view, weekStart, monthAnchor]);
  const byDay = useMemo(() => {
    const m = new Map<string, MkCalItem[]>();
    mk.items.forEach((it) => { const k = dayKey(new Date(it.t)); const a = m.get(k) ?? []; a.push(it); m.set(k, a); });
    return m;
  }, [mk.items]);
  const todayK = dayKey(new Date());
  const onOpen = (it: MkCalItem, r: DOMRect) => setPeek((p) => (p?.it.key === it.key ? null : { it, from: r }));
  const days = Array.from({ length: view === "month" ? 42 : 7 }, (_, i) => addDays(mk.from, i));
  const cells = view === "month" && days[35].getMonth() !== monthAnchor.getMonth() ? days.slice(0, 35) : days;
  const empty = !mk.loading && !mk.items.length;
  // drag a post (or a draft / idea from the side) onto a day
  const [dragIt, setDragIt] = useState<MkCalItem | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { if (!note) return; const t = window.setTimeout(() => setNote(null), 3200); return () => window.clearTimeout(t); }, [note]);
  const drag: Drag = { item: dragIt, start: (it) => { setPeek(null); setDragIt(it); }, end: () => { setDragIt(null); setOver(null); } };
  const dropOn = (k: string) => ({
    onDragOver: (e: React.DragEvent) => { if (!dragIt) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (over !== k) setOver(k); },
    onDragLeave: (e: React.DragEvent) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver((o) => (o === k ? null : o)); },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const it = dragIt; setDragIt(null); setOver(null);
      if (!it || (Number.isFinite(it.t) && dayKey(new Date(it.t)) === k)) return;
      void mk.move(it, k).then((err) => setNote(err ? `Couldn't move it: ${err}` : `Moved to ${new Date(`${k}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}`));
    },
  });

  let body: React.ReactNode;
  if (view === "week") {
    body = (
      <div className="cmk-week">
        {cells.map((d, i) => {
          const k = dayKey(d), its = byDay.get(k) ?? [];
          const past = k < todayK;
          return (
            <section key={k} className={`cmk-col ${k === todayK ? "is-today" : ""} ${past ? "is-past" : ""} ${i >= 5 ? "is-we" : ""} ${over === k ? "is-over" : ""}`} style={{ ["--i" as string]: i } as CSSProperties} {...dropOn(k)}>
              <header className="cmk-col-h">
                <b>{d.getDate()}</b><em>{DOW[i]}</em>
                {its.length > 0 && <i>{its.length}</i>}
              </header>
              <ScrollList className="cmk-col-list">
                {its.map((it) => <MkCard key={it.key} it={it} onOpen={onOpen} drag={drag} />)}
                {!past && (
                  <button type="button" className={`cmk-add ${its.length ? "" : "is-alone"}`} onClick={() => open({ kind: "new", day: k })} title="Plan a post this day">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                    <span>Post</span>
                  </button>
                )}
              </ScrollList>
            </section>
          );
        })}
      </div>
    );
  } else {
    const cap = cells.length > 35 ? 2 : 3;
    body = (
      <div className="cmk-month">
        <div className="cmk-dow">{DOW.map((n) => <span key={n}>{n}</span>)}</div>
        <div className="cmk-mgrid" style={{ gridTemplateRows: `repeat(${cells.length / 7}, minmax(0, 1fr))` }}>
          {cells.map((d, i) => {
            const k = dayKey(d), its = byDay.get(k) ?? [];
            const out = d.getMonth() !== monthAnchor.getMonth();
            return (
              <div key={k} className={`cmk-mcell ${out ? "is-out" : ""} ${k === todayK ? "is-today" : ""} ${i % 7 >= 5 ? "is-we" : ""} ${over === k ? "is-over" : ""}`} {...dropOn(k)}>
                <span className="cmk-mday"><b>{d.getDate()}</b></span>
                <div className="cmk-mlist">
                  {its.slice(0, its.length > cap ? cap - 1 : cap).map((it) => (
                    <button key={it.key} type="button" className={`cmk-chipev is-${it.kind} is-st-${it.status} ${dragIt?.key === it.key ? "is-dragging" : ""}`}
                      draggable={movable(it) || undefined}
                      onDragStart={movable(it) ? (e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", it.key); drag.start(it); } : undefined}
                      onDragEnd={movable(it) ? drag.end : undefined}
                      style={{ ["--c" as string]: it.kind === "email" ? MAIL_C : netOf(it.nets[0]).color } as CSSProperties}
                      title={`${hm(it.t)} · ${it.title}`} onClick={(e) => onOpen(it, e.currentTarget.getBoundingClientRect())}>
                      <MkMark kind={it.kind} net={it.nets[0]} size={16} solid /><em>{hm(it.t)}</em><span>{it.title}</span>
                    </button>
                  ))}
                  {its.length > cap && (
                    <button type="button" className="cmk-mmore" onClick={() => onOpenWeek?.(d)} title="Open this week">+{its.length - cap + 1} more</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className={`cmk-wrap ${mk.side ? "has-side" : "is-folded"} ${dragIt ? "is-dragging" : ""}`}>
    <div className={`cmk is-${view} ${mk.refreshing ? "is-busy" : ""}`}>
      {body}
      {mk.loading && <div className="cmk-veil"><span className="cmk-spin" /></div>}
      {empty && (
        <div className="cmk-empty">
          <span className="cmk-empty-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={MEGAPHONE} /></svg></span>
          <b>{mk.missing ? "Marketing isn't set up yet" : mk.error ? "Couldn't read Marketing" : !mk.show.email && !mk.show.post ? "E-mails and posts are hidden" : `Nothing planned ${view === "month" ? "this month" : "this week"}`}</b>
          <em>{mk.error ? mk.error : !mk.show.email && !mk.show.post ? "Turn one of them on above." : "E-mail campaigns and social posts show here on the day they go out."}</em>
          {!mk.missing && !mk.error && (mk.show.email || mk.show.post) && (
            <button type="button" className="cmk-empty-btn" onClick={() => open({ kind: "new" })}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>Plan a post
            </button>
          )}
        </div>
      )}
      {note && <div className="cmk-note" role="status">{note}</div>}
    </div>
    <MkSide mk={mk} onOpen={onOpen} drag={drag} />
    {peek && <MkPeek it={peek.it} from={peek.from} onClose={() => setPeek(null)} />}
    </div>
  );
}

/* ---------- the side: Up next · Not planned yet (as in Marketing › Calendar) ---------- */
const SIDE_I = {
  next: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
  idea: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.2h5c0-.9.4-1.7 1.1-2.2A6 6 0 0 0 12 3z",
  fold: "M9 6l6 6-6 6",
  spark: "M12 3l1.8 4.6L18.5 9.5l-4.7 1.9L12 16l-1.8-4.6L5.5 9.5l4.7-1.9zM19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z",
  grip: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
};
const SideIco = ({ d, s = 16 }: { d: string; s?: number }) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
function MkSide({ mk, onOpen, drag }: { mk: CalendarMarketingState; onOpen: (it: MkCalItem, r: DOMRect) => void; drag: Drag }) {
  const open = useOpenInMarketing();
  if (!mk.side) {
    return (
      <aside className="cmk-side is-rail" aria-label="Up next and not planned yet">
        <button type="button" className="cmk-rail-btn" onClick={() => mk.setSide(true)} title="Show what's up next and what has no day yet">
          <SideIco d={SIDE_I.fold} s={15} />
        </button>
        <button type="button" className="cmk-rail-btn is-next" onClick={() => mk.setSide(true)} title="Up next">
          <SideIco d={SIDE_I.next} /><b>{mk.upcoming.length}</b>
        </button>
        <button type="button" className="cmk-rail-btn is-idea" onClick={() => mk.setSide(true)} title="Not planned yet">
          <SideIco d={SIDE_I.idea} /><b>{mk.unplanned.length}</b>
        </button>
      </aside>
    );
  }
  return (
    <aside className="cmk-side" aria-label="Up next and not planned yet">
      <section className="cmk-sc cmk-next">
        <header>
          <span className="cmk-sc-ico is-next"><SideIco d={SIDE_I.next} s={15} /></span>
          <h3>Up next</h3><em>{mk.upcoming.length}</em>
          <button type="button" className="cmk-fold" onClick={() => mk.setSide(false)} title="Fold this column" aria-label="Fold this column"><SideIco d={SIDE_I.fold} s={14} /></button>
        </header>
        {mk.upcoming.length ? (
          <ScrollList className="cmk-sc-list" count={false}>
            {mk.upcoming.map((it, i) => {
              const d = new Date(it.t);
              return (
                <button key={it.key} type="button" className={`cmk-nx is-st-${it.status}`} style={{ ["--c" as string]: it.kind === "email" ? MAIL_C : netOf(it.nets[0]).color, ["--i" as string]: i } as CSSProperties}
                  onClick={(e) => onOpen(it, e.currentTarget.getBoundingClientRect())}>
                  <span className="cmk-nx-d"><b>{d.getDate()}</b><em>{d.toLocaleDateString("en-GB", { month: "short" })}</em></span>
                  <span className="cmk-nx-t">
                    <b>{it.title}</b>
                    <em><MkMark kind={it.kind} net={it.nets[0]} size={14} solid />{d.toLocaleDateString("en-GB", { weekday: "short" })} · {hm(it.t)}</em>
                  </span>
                  {(it.status === "due" || it.status === "draft" || it.status === "idea" || it.status === "failed") && <small className={`cmk-st is-${it.status}`}><i />{MK_STATUS[it.status]}</small>}
                </button>
              );
            })}
          </ScrollList>
        ) : <p className="cmk-sc-empty">Nothing planned from now on.</p>}
      </section>
      <section className="cmk-sc cmk-unpl">
        <header>
          <span className="cmk-sc-ico is-idea"><SideIco d={SIDE_I.idea} s={15} /></span>
          <h3>Not planned yet</h3><em>{mk.unplanned.length}</em>
        </header>
        <p className="cmk-sc-hint">Drag a draft or an idea onto a day. Posts move the same way; their time stays.</p>
        <ScrollList className="cmk-sc-list" count={false}>
          {mk.unplanned.map((it, i) => (
            <button key={it.key} type="button" className={`cmk-idea ${drag.item?.key === it.key ? "is-dragging" : ""}`} draggable
              style={{ ["--c" as string]: netOf(it.nets[0]).color, ["--i" as string]: i } as CSSProperties}
              onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", it.key); drag.start(it); }}
              onDragEnd={drag.end}
              onClick={(e) => onOpen(it, e.currentTarget.getBoundingClientRect())}>
              <i className="cmk-grip"><SideIco d={SIDE_I.grip} s={14} /></i>
              <span className="cmk-idea-t">
                <b>{it.title}</b>
                <em>{it.nets.slice(0, 4).map((n) => <MkMark key={n} kind="post" net={n} size={14} solid />)}<span>{MK_STATUS[it.status] ?? it.status}</span></em>
              </span>
            </button>
          ))}
          {!mk.unplanned.length && <p className="cmk-sc-empty">No drafts or ideas waiting.</p>}
        </ScrollList>
        <footer className="cmk-sc-f">
          <button type="button" className="cmk-sc-btn" onClick={() => open({ kind: "new", nets: [] })}>
            <SideIco d="M12 5v14M5 12h14" s={14} />Draft
          </button>
          <button type="button" className="cmk-sc-btn is-ai" onClick={() => open({ kind: "ai" })}>
            <SideIco d={SIDE_I.spark} s={14} />Plan posts with AI
          </button>
        </footer>
      </section>
    </aside>
  );
}
