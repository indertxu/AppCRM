/**
 * BASE · Growth › Marketing › Ads.
 * One wallet pays every ad platform (Google Ads, LinkedIn Ads, Meta, TikTok): add funds to it, then decide how
 * much of it each ad campaign gets — or take money back. The top of the page is a board each person arranges
 * like the Overview (which figures and cards, where, how big — saved with the person, "mkAds"); the list of
 * ad campaigns is always at the bottom, with room for at least six.
 * Not wired to the ad platforms or to payments yet: the wallet, the campaigns and the movements are kept in this
 * browser (localStorage "next-ads-v1") and start empty.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BRANDS } from "./brandIcons";
import { HomeBoard, compactAll, firstFit, newId, COLS, GAP, type BoardItem, type BoardKit } from "../../homepage/HomePage";
import { loadPrefs, savePref } from "../../companies/companiesApi";
import "./AdsTab.css";

type Pf = "gads" | "linkedin" | "meta" | "tiktok";
const PF: Record<Pf, { name: string; sub: string; color: string }> = {
  gads: { name: "Google Ads", sub: "Search, display and YouTube", color: "#4285F4" },
  linkedin: { name: "LinkedIn Ads", sub: "Sponsored posts and lead forms", color: "#0A66C2" },
  meta: { name: "Meta Ads", sub: "Facebook and Instagram", color: "#0467DF" },
  tiktok: { name: "TikTok Ads", sub: "Short videos", color: "#111111" },
};
const PF_KEYS = Object.keys(PF) as Pf[];
type Goal = "Leads" | "Website visits" | "Awareness";
type Status = "live" | "paused" | "draft";
type Camp = { id: string; pf: Pf; name: string; goal: Goal; status: Status; budget: number; spent: number; daily: number; clicks: number; leads: number; created: string };
type Move = { id: string; at: string; kind: "funds" | "to" | "back"; amount: number; camp?: string };
type Store = { v: 1; wallet: number; auto: boolean; linked: Pf[]; camps: Camp[]; moves: Move[] };

const STORE_KEY = "next-ads-v1";
const EMPTY: Store = { v: 1, wallet: 0, auto: false, linked: [], camps: [], moves: [] };
function readStore(): Store {
  try { const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null"); if (v && v.v === 1 && Array.isArray(v.camps)) return { ...EMPTY, ...v }; } catch { /* */ }
  return EMPTY;
}
const eur = (n: number) => `${Math.round(n).toLocaleString("en-GB")} €`;
const ST: Record<Status, string> = { live: "Live", paused: "Paused", draft: "Draft" };
const when = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + ", " + new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/* ---------- icons ---------- */
const svg = (d: ReactNode, s = 18) => <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>;
export const ADS_ICO = svg(<><path d="M3 11l15-6v14L3 13z" /><path d="M7 13v5a2 2 0 0 0 4 0v-3.5" /><path d="M21 9v4" /></>, 16);
const I = {
  wallet: svg(<><path d="M3 7a2 2 0 0 1 2-2h12v4" /><path d="M3 7v10a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2z" /><circle cx="16" cy="14" r="1.2" fill="currentColor" /></>),
  plus: svg(<path d="M12 5v14M5 12h14" />, 16),
  minus: svg(<path d="M5 12h14" />, 16),
  x: svg(<path d="M18 6 6 18M6 6l12 12" />, 16),
  play: svg(<path d="M7 5l12 7-12 7z" />, 14),
  pause: svg(<path d="M8 5v14M16 5v14" />, 14),
  arrow: svg(<path d="M5 12h14M13 6l6 6-6 6" />, 15),
  back: svg(<path d="M19 12H5M11 18l-6-6 6-6" />, 15),
  spend: svg(<><path d="M4 19h16" /><path d="M7 15l4-4 3 3 5-6" /></>),
  given: svg(<><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M5 21h14" /></>),
  leads: svg(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M17 8v6M14 11h6" /></>),
  cpl: svg(<><circle cx="12" cy="12" r="9" /><path d="M15 9.5a3 3 0 1 0 0 5M8 11h5M8 13.5h5" /></>),
  click: svg(<><path d="M9 3v3M3 9h3M5 5l2 2" /><path d="M10 10l10 4-4 2-2 4z" /></>),
  day: svg(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  bolt: svg(<path d="M13 2 4 14h7l-1 8 9-12h-7z" />),
  grid: svg(<><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></>),
  pie: svg(<><path d="M12 3a9 9 0 1 0 9 9h-9z" /><path d="M15 3.5A9 9 0 0 1 20.5 9H15z" /></>),
  low: svg(<><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></>),
  star: svg(<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />),
  list: svg(<><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></>),
  quick: svg(<><path d="M12 5v14M5 12h14" /></>),
  sliders: svg(<><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></>, 16),
};
function Logo({ pf, s = 20 }: { pf: Pf; s?: number }) {
  const b = BRANDS[pf];
  return <svg className="ads-logo" viewBox="0 0 24 24" width={s} height={s} role="img" aria-label={PF[pf].name} style={{ color: b?.hex ?? PF[pf].color } as CSSProperties}><path d={b?.path ?? ""} fill="currentColor" /></svg>;
}

/* ---------- the board: figures and cards each person picks ---------- */
type AdKey = "k.wallet" | "k.given" | "k.spent" | "k.left" | "k.leads" | "k.cpl" | "k.clicks" | "k.daily" | "k.running"
  | "wallet" | "platforms" | "split" | "low" | "best" | "moves" | "quick";
type AdGroup = "Figures" | "Money" | "Campaigns";
const AD: Record<AdKey, { title: string; hint: string; group: AdGroup; def: [number, number]; min: [number, number]; fig?: boolean; ico: ReactNode }> = {
  "k.wallet": { title: "In the wallet", hint: "What's left to give to campaigns", group: "Figures", def: [4, 3], min: [3, 3], fig: true, ico: I.wallet },
  "k.given": { title: "Given to campaigns", hint: "Everything sent from the wallet to running or paused campaigns", group: "Figures", def: [4, 3], min: [3, 3], fig: true, ico: I.given },
  "k.spent": { title: "Spent", hint: "What the platforms have used of it", group: "Figures", def: [4, 3], min: [3, 3], fig: true, ico: I.spend },
  "k.left": { title: "Left in campaigns", hint: "Given but not spent yet", group: "Figures", def: [4, 3], min: [3, 3], fig: true, ico: I.pie },
  "k.leads": { title: "Leads from ads", hint: "People who left their details", group: "Figures", def: [4, 3], min: [3, 3], fig: true, ico: I.leads },
  "k.cpl": { title: "Cost per lead", hint: "Spent ÷ leads", group: "Figures", def: [4, 3], min: [3, 3], fig: true, ico: I.cpl },
  "k.clicks": { title: "Clicks", hint: "Clicks on your ads", group: "Figures", def: [4, 3], min: [3, 3], fig: true, ico: I.click },
  "k.daily": { title: "A day", hint: "What the running campaigns can spend a day", group: "Figures", def: [4, 3], min: [3, 3], fig: true, ico: I.day },
  "k.running": { title: "Running", hint: "Campaigns live now, of all of them", group: "Figures", def: [4, 3], min: [3, 3], fig: true, ico: I.bolt },
  wallet: { title: "Wallet", hint: "Balance, auto top-up, add funds, send to a campaign", group: "Money", def: [8, 5], min: [6, 4], ico: I.wallet },
  platforms: { title: "Platforms", hint: "Google, LinkedIn, Meta and TikTok: connected, given, spent", group: "Money", def: [10, 5], min: [6, 4], ico: I.grid },
  split: { title: "Where the money goes", hint: "Given and spent, per platform", group: "Money", def: [8, 5], min: [6, 4], ico: I.pie },
  moves: { title: "Wallet movements", hint: "Funds added, money sent to campaigns and taken back", group: "Money", def: [8, 5], min: [6, 4], ico: I.list },
  low: { title: "Running low", hint: "Live campaigns with less than five days of money", group: "Campaigns", def: [8, 5], min: [6, 4], ico: I.low },
  best: { title: "Best cost per lead", hint: "Your campaigns, cheapest lead first", group: "Campaigns", def: [8, 5], min: [6, 4], ico: I.star },
  quick: { title: "Quick actions", hint: "Add funds, a new ad campaign, move money", group: "Campaigns", def: [8, 5], min: [5, 4], ico: I.quick },
};
const AD_KEYS = Object.keys(AD) as AdKey[];
const AD_GROUPS: AdGroup[] = ["Figures", "Money", "Campaigns"];
const AD_PREF = "mkAds";
/** the board is this many rows and they share the height above the list */
const AD_ROWS = 8;
const adFits = (items: BoardItem[]) => items.every((i) => i.y + i.h <= AD_ROWS);
interface AdBoard { v: 1; items: BoardItem[] }
const adItem = (key: AdKey, x: number, y: number, w: number, h: number): BoardItem => ({ id: newId(), key, x, y, w, h });
function adDefault(): AdBoard {
  return { v: 1, items: compactAll([
    adItem("k.wallet", 0, 0, 4, 3), adItem("k.given", 4, 0, 4, 3), adItem("k.spent", 8, 0, 4, 3), adItem("k.leads", 12, 0, 4, 3), adItem("k.cpl", 16, 0, 4, 3), adItem("k.running", 20, 0, 4, 3),
    adItem("platforms", 0, 3, 16, 5), adItem("quick", 16, 3, 8, 5),
  ]) };
}
function readAdBoard(v: any): AdBoard | null {
  if (!v || v.v !== 1 || !Array.isArray(v.items)) return null;
  const items: BoardItem[] = v.items
    .filter((i: any, n: number, all: any[]) => i && AD[i.key as AdKey] && all.findIndex((x: any) => x?.key === i.key) === n)
    .map((i: any) => {
      const d = AD[i.key as AdKey];
      const w = Math.max(d.min[0], Math.min(COLS, Math.round(Number(i.w) || d.def[0])));
      const h = Math.max(d.min[1], Math.min(AD_ROWS, Math.round(Number(i.h) || d.def[1])));
      return { id: typeof i.id === "string" ? i.id : newId(), key: i.key, x: Math.max(0, Math.min(COLS - w, Math.round(Number(i.x) || 0))), y: Math.max(0, Math.round(Number(i.y) || 0)), w, h };
    });
  const kept = compactAll(items).filter((i) => i.y + i.h <= AD_ROWS);
  return kept.length ? { v: 1, items: kept } : null;
}
const AD_KIT: BoardKit = {
  screenRows: AD_ROWS,
  min: (k) => AD[k as AdKey]?.min ?? [3, 3],
  title: (k) => AD[k as AdKey]?.title ?? k,
  icon: (k) => AD[k as AdKey]?.ico ?? null,
  color: () => "#0c875f",
  shown: (it) => it.key,
  fig: () => false,
  link: () => false,
  look: (it, pxW) => (AD[it.key as AdKey]?.fig ? "Figure" : pxW < 380 ? "Slim" : pxW >= 760 ? "Wide" : "Standard"),
  cls: (it, pxW, pxH) => ["mo-cell", AD[it.key as AdKey]?.fig ? "is-mofig" : "", pxW < 200 ? "mo-xs" : "", pxH < 300 ? "mo-short" : "", it.y + it.h > AD_ROWS ? "is-out" : ""].filter(Boolean).join(" "),
  snug: () => false,
  presets: (k) => {
    const d = AD[k as AdKey];
    if (!d) return [];
    if (d.fig) return [{ label: "Small", w: 3, h: 3 }, { label: "Standard", w: 4, h: 3 }, { label: "Wide", w: 6, h: 3 }];
    return [{ label: "Small", w: d.min[0], h: d.min[1] }, { label: "Standard", w: d.def[0], h: d.def[1] }, { label: "Wide", w: Math.min(COLS, d.def[0] + 6), h: d.def[1] }, { label: "Full width", w: COLS, h: d.def[1] }]
      .filter((p, i, all) => all.findIndex((q) => q.w === p.w && q.h === p.h) === i);
  },
  stackH: (it) => (AD[it.key as AdKey]?.fig ? 136 : 300),
};

/* ---------- the tab ---------- */
export default function AdsTab({ bar, toast, editing, onEditing }: { bar: HTMLElement | null; toast: (s: string) => void; editing: boolean; onEditing: (on: boolean) => void }) {
  const [store, setStore] = useState<Store>(readStore);
  useEffect(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* */ } }, [store]);
  const { wallet, auto, camps, moves } = store;
  const linked = new Set(store.linked);
  const put = (f: (s: Store) => Store) => setStore((s) => f(s));
  const [pf, setPf] = useState<Pf | "all">("all");
  const [st, setSt] = useState<Status | "all">("all");
  const [panel, setPanel] = useState<null | { k: "funds" } | { k: "move"; id: string | null } | { k: "new"; pf?: Pf }>(null);

  const active = camps.filter((c) => c.status !== "draft");
  const given = active.reduce((s, c) => s + c.budget, 0);
  const spent = camps.reduce((s, c) => s + c.spent, 0);
  const leads = camps.reduce((s, c) => s + c.leads, 0);
  const clicks = camps.reduce((s, c) => s + c.clicks, 0);
  const perDay = camps.filter((c) => c.status === "live").reduce((s, c) => s + c.daily, 0);
  const running = camps.filter((c) => c.status === "live").length;
  const byPf = (p: Pf) => { const cs = camps.filter((c) => c.pf === p); return { n: cs.length, live: cs.filter((c) => c.status === "live").length, budget: cs.reduce((s, c) => s + c.budget, 0), spent: cs.reduce((s, c) => s + c.spent, 0) }; };
  const shown = camps.filter((c) => (pf === "all" || c.pf === pf) && (st === "all" || c.status === st));
  const lowOnes = camps.filter((c) => c.status === "live" && c.budget - c.spent < c.daily * 5);
  const bestOnes = [...camps].filter((c) => c.leads > 0).sort((a, b) => a.spent / a.leads - b.spent / b.leads);

  const log = (m: Omit<Move, "id" | "at">) => ({ id: newId(), at: new Date().toISOString(), ...m });
  const addFunds = (v: number) => { put((s) => ({ ...s, wallet: s.wallet + v, moves: [log({ kind: "funds", amount: v }), ...s.moves].slice(0, 200) })); toast(`${eur(v)} added to the wallet`); };
  const move = (id: string, amount: number) => {
    const c = camps.find((x) => x.id === id); if (!c || !amount) return;
    put((s) => ({ ...s, wallet: s.wallet - amount, camps: s.camps.map((y) => (y.id === id ? { ...y, budget: Math.max(y.spent, y.budget + amount) } : y)),
      moves: [log({ kind: amount > 0 ? "to" : "back", amount: Math.abs(amount), camp: c.name }), ...s.moves].slice(0, 200) }));
    toast(amount > 0 ? `${eur(amount)} sent to "${c.name}"` : `${eur(-amount)} back in the wallet`);
  };
  const create = (c: Camp) => {
    put((s) => ({ ...s, camps: [c, ...s.camps], wallet: s.wallet - c.budget, moves: c.budget ? [log({ kind: "to", amount: c.budget, camp: c.name }), ...s.moves].slice(0, 200) : s.moves }));
    toast(`"${c.name}" ${c.status === "live" ? "launched" : "saved as a draft"}`);
  };
  const connect = (k: Pf) => { put((s) => ({ ...s, linked: [...new Set([...s.linked, k])] })); toast(`${PF[k].name} connected`); };
  const toggle = (c: Camp) => { put((s) => ({ ...s, camps: s.camps.map((y) => (y.id === c.id ? { ...y, status: y.status === "live" ? "paused" : "live" } : y)) })); toast(c.status === "live" ? "Paused" : "Running again"); };
  const remove = (c: Camp) => { put((s) => ({ ...s, wallet: s.wallet + Math.max(0, c.budget - c.spent), camps: s.camps.filter((y) => y.id !== c.id) })); toast(`"${c.name}" deleted${c.budget - c.spent > 0 ? ` — ${eur(c.budget - c.spent)} back in the wallet` : ""}`); };

  /* ---- the board (saved with the person; a draft while customizing) ---- */
  const [board, setBoard] = useState<AdBoard | null>(null);
  const [draft, setDraft] = useState<AdBoard | null>(null);
  const [lib, setLib] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [preview, setPreview] = useState<BoardItem[] | null>(null);
  const [noRoom, setNoRoom] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadPrefs().catch(() => ({} as Record<string, any>)).then((p) => { if (alive) setBoard(readAdBoard((p as Record<string, any>)?.[AD_PREF]) ?? adDefault()); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (editing && board && !draft) setDraft({ ...board, items: compactAll(board.items) });
    if (!editing && draft) { setDraft(null); setLib(false); setPreview(null); }
  }, [editing, board]); // eslint-disable-line react-hooks/exhaustive-deps
  const live = draft ?? board;
  const items = live?.items ?? [];
  const warn = (msg: string) => { setNoRoom(msg); window.setTimeout(() => setNoRoom((m) => (m === msg ? null : m)), 3200); };
  const overflow = !!draft && !adFits(draft.items);
  const finish = (save: boolean) => {
    if (save && draft && !adFits(draft.items)) { warn("Some cards are below the line — make room for them first"); return; }
    if (save && draft) { setBoard(draft); savePref(AD_PREF, draft).catch(() => {}); }
    setDraft(null); setLib(false); setPreview(null); onEditing(false);
  };
  const addCard = (key: AdKey) => {
    if (!draft) return;
    const d = AD[key];
    const sizes: [number, number][] = [d.def, [d.def[0], d.min[1]], [d.min[0], d.def[1]], d.min];
    const putIt = (w: number, h: number, below: boolean) => {
      const at = firstFit(draft.items, w, h);
      const it: BoardItem = { id: newId(), key, x: at.x, y: at.y, w, h };
      setDraft({ ...draft, items: [...draft.items, it] });
      setFlash(it.id); window.setTimeout(() => setFlash((f) => (f === it.id ? null : f)), 1600);
      if (below) warn(`“${d.title}” went below the line — make room for it`);
    };
    for (const [w, h] of sizes) if (firstFit(draft.items, w, h).y + h <= AD_ROWS) return putIt(w, h, false);
    putIt(d.def[0], d.def[1], true);
  };
  useEffect(() => {
    if (!editing) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector(".hb-sizes") && !lib) finish(false); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [editing, lib]); // eslint-disable-line react-hooks/exhaustive-deps
  const fitRef = useRef<HTMLDivElement>(null);
  const [availH, setAvailH] = useState(0);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  useLayoutEffect(() => {
    const el = fitRef.current; if (!el) return;
    const m = () => { if (!editingRef.current) setAvailH(el.clientHeight); };
    m();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(m) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [board]);
  const step = availH ? Math.max(24, (availH - 8 + GAP) / AD_ROWS) : 36;
  const [els, setEls] = useState<Record<string, HTMLElement>>({});
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const slotRef = (id: string) => {
    let f = refs.current.get(id);
    if (!f) {
      f = (el: HTMLElement | null) => setEls((m) => {
        if (el) return m[id] === el ? m : { ...m, [id]: el };
        if (!(id in m)) return m;
        const next = { ...m }; delete next[id]; return next;
      });
      refs.current.set(id, f);
    }
    return f;
  };
  const figRank = new Map((preview ?? items).filter((i) => AD[i.key as AdKey]?.fig).sort((a, b) => a.y - b.y || a.x - b.x).map((i, n) => [i.key, n]));

  /* ---- the cards ---- */
  const fig = (k: AdKey, v: ReactNode, sub: ReactNode, go?: () => void) => {
    const r = figRank.get(k) ?? 9;
    return (
      <button type="button" className={`mo-card mo-fig ${r === 0 ? "is-pine" : r === 1 ? "is-green" : r === 2 ? "is-lime" : ""}`} onClick={editing ? undefined : go}>
        <span className="mo-fig-h"><span className="mo-fig-k">{AD[k].title}</span><i>{AD[k].ico}</i></span>
        <span className="mo-fig-row"><b className="mo-fig-v">{v}</b></span>
        <em className="mo-fig-s">{sub}</em>
      </button>
    );
  };
  const box = (k: AdKey, sub: ReactNode, body: ReactNode, extra = "") => (
    <section className={`mo-card mo-panel ads-panel ${extra}`}>
      <header className="mo-h"><span className="mo-h-ico">{AD[k].ico}</span><span className="mo-h-t"><b>{AD[k].title}</b>{sub ? <em>{sub}</em> : null}</span></header>
      <div className="mo-b ads-pb">{body}</div>
    </section>
  );
  const none = (t: string, act?: ReactNode) => <div className="ads-none"><p>{t}</p>{act}</div>;
  const card = (k: AdKey): ReactNode => {
    switch (k) {
      case "k.wallet": return fig(k, eur(wallet), perDay ? `about ${Math.floor(wallet / perDay)} days at ${eur(perDay)}/day` : "add funds to start", () => setPanel({ k: "funds" }));
      case "k.given": return fig(k, eur(given), `${active.length} campaign${active.length === 1 ? "" : "s"}`);
      case "k.spent": return fig(k, eur(spent), given ? `${Math.round((spent / given) * 100)}% of what they got` : "nothing yet");
      case "k.left": return fig(k, eur(Math.max(0, given - spent)), "given, not spent yet");
      case "k.leads": return fig(k, leads, clicks ? `from ${clicks.toLocaleString("en-GB")} clicks` : "none yet");
      case "k.cpl": return fig(k, leads ? eur(spent / leads) : "—", leads ? `${leads} leads` : "no leads yet");
      case "k.clicks": return fig(k, clicks.toLocaleString("en-GB"), spent && clicks ? `${eur(spent / clicks)} a click` : "none yet");
      case "k.daily": return fig(k, eur(perDay), `${running} running`);
      case "k.running": return fig(k, <>{running}<small> of {camps.length}</small></>, camps.length ? "campaigns" : "no campaigns yet");
      case "wallet": return box(k, auto ? "Tops up 500 € when below 200 €" : "Pays every ad platform", (
        <div className="ads-w">
          <b className="ads-w-v">{eur(wallet)}</b>
          <p>{perDay ? <>Covers about <em>{Math.floor(wallet / perDay)} days</em> at {eur(perDay)}/day</> : "Nothing is running"}</p>
          <div className="ads-w-a">
            <button className="ads-btn is-lime is-sm" onClick={() => setPanel({ k: "funds" })}>{I.plus}Add funds</button>
            <button className="ads-btn is-ghost is-sm" disabled={!camps.length} onClick={() => setPanel({ k: "move", id: null })}>{I.arrow}Send to a campaign</button>
            <button className={`ads-auto ${auto ? "is-on" : ""}`} onClick={() => { put((s) => ({ ...s, auto: !s.auto })); toast(auto ? "Auto top-up off" : "Auto top-up on: 500 € when it drops below 200 €"); }} aria-pressed={auto}><i className="ads-sw" />Auto top-up</button>
          </div>
        </div>
      ), "is-wallet");
      case "platforms": return box(k, `${linked.size} of ${PF_KEYS.length} connected`, (
        <div className="ads-pfl">
          {PF_KEYS.map((p) => {
            const s = byPf(p), on = linked.has(p);
            return (
              <div key={p} className={`ads-pfl-r ${on ? "" : "is-off"}`} style={{ ["--n" as string]: BRANDS[p]?.hex ?? PF[p].color } as CSSProperties}>
                <span className="ads-pfl-ico"><Logo pf={p} s={18} /></span>
                <span className="ads-pfl-t"><b>{PF[p].name}</b><em>{on ? (s.n ? `${s.live} live · ${s.n} campaign${s.n === 1 ? "" : "s"}` : "No campaigns yet") : PF[p].sub}</em></span>
                {on ? <span className="ads-pfl-m"><span className="ads-bar is-sm"><i style={{ width: `${s.budget ? Math.min(100, (s.spent / s.budget) * 100) : 0}%` }} /></span><b>{eur(s.spent)}</b><em>of {eur(s.budget)}</em></span>
                  : <button className="ads-btn is-ghost is-sm" onClick={() => connect(p)}>Connect</button>}
              </div>
            );
          })}
        </div>
      ));
      case "split": {
        const rows = PF_KEYS.map((p) => ({ p, ...byPf(p) })).filter((r) => r.budget > 0);
        const max = Math.max(1, ...rows.map((r) => r.budget));
        return box(k, given ? `${eur(given)} given` : "", rows.length ? (
          <div className="ads-split">{rows.map((r) => (
            <div key={r.p} className="ads-split-r" style={{ ["--n" as string]: BRANDS[r.p]?.hex ?? PF[r.p].color } as CSSProperties}>
              <Logo pf={r.p} s={16} /><span className="ads-split-b"><i style={{ width: `${(r.budget / max) * 100}%` }}><i style={{ width: `${r.budget ? (r.spent / r.budget) * 100 : 0}%` }} /></i></span><b>{eur(r.budget)}</b>
            </div>
          ))}</div>
        ) : none("Nothing given to campaigns yet."));
      }
      case "moves": return box(k, moves.length ? `${moves.length}` : "", moves.length ? (
        <ul className="ads-moves">{moves.slice(0, 30).map((m) => (
          <li key={m.id} className={`is-${m.kind}`}><i>{m.kind === "funds" ? I.plus : m.kind === "to" ? I.arrow : I.back}</i>
            <span><b>{m.kind === "funds" ? "Funds added" : m.kind === "to" ? `To ${m.camp}` : `Back from ${m.camp}`}</b><em>{when(m.at)}</em></span>
            <strong>{m.kind === "to" ? "−" : "+"}{eur(m.amount)}</strong></li>
        ))}</ul>
      ) : none("Funds you add and money you move show here."));
      case "low": return box(k, lowOnes.length ? `${lowOnes.length}` : "", lowOnes.length ? (
        <ul className="ads-mini">{lowOnes.map((c) => (
          <li key={c.id}><Logo pf={c.pf} s={16} /><span><b>{c.name}</b><em>{eur(Math.max(0, c.budget - c.spent))} left · {Math.max(0, Math.floor((c.budget - c.spent) / Math.max(1, c.daily)))} days</em></span>
            <button className="ads-btn is-lime is-sm" onClick={() => setPanel({ k: "move", id: c.id })}>{I.plus}Top up</button></li>
        ))}</ul>
      ) : none("Every running campaign has money for more than five days."));
      case "best": return box(k, "", bestOnes.length ? (
        <ul className="ads-mini">{bestOnes.slice(0, 8).map((c, i) => (
          <li key={c.id}><span className="ads-rank">{i + 1}</span><Logo pf={c.pf} s={16} /><span><b>{c.name}</b><em>{c.leads} leads</em></span><strong>{eur(c.spent / c.leads)}</strong></li>
        ))}</ul>
      ) : none("Once your ads bring leads, the cheapest ones show here."));
      case "quick": return box(k, "", (
        <div className="ads-quick">
          <button onClick={() => setPanel({ k: "funds" })}><i>{I.plus}</i><b>Add funds</b><em>To the wallet</em></button>
          <button onClick={() => setPanel({ k: "new" })}><i>{ADS_ICO}</i><b>New ad campaign</b><em>Google, LinkedIn, Meta, TikTok</em></button>
          <button disabled={!camps.length} onClick={() => setPanel({ k: "move", id: null })}><i>{I.arrow}</i><b>Move money</b><em>Wallet ↔ a campaign</em></button>
        </div>
      ));
    }
  };

  const tools = (
    <div className="em-tools ads-tools">
      <div className="ads-pfs" role="group" aria-label="Platform">
        <button className={`is-all ${pf === "all" ? "is-on" : ""}`} onClick={() => setPf("all")}>All</button>
        {PF_KEYS.map((k) => (
          <button key={k} className={`${pf === k ? "is-on" : ""} ${pf !== "all" && pf !== k ? "is-dim" : ""}`} style={{ ["--n" as string]: BRANDS[k]?.hex ?? PF[k].color } as CSSProperties}
            onClick={() => setPf(pf === k ? "all" : k)} title={PF[k].name} aria-label={PF[k].name} aria-pressed={pf === k}><Logo pf={k} s={18} /></button>
        ))}
      </div>
      <button type="button" className={`ads-cust ${editing ? "is-on" : ""}`} onClick={() => onEditing(!editing)} title="Choose the figures and cards of this page, move them and resize them" aria-pressed={editing}>{I.sliders}<span>Customize</span></button>
      <button type="button" className="ads-funds-b" onClick={() => setPanel({ k: "funds" })}>{I.plus}Add funds</button>
      <button type="button" className="em-new" onClick={() => setPanel({ k: "new", pf: pf === "all" ? undefined : pf })}>{I.plus}<span>New ad campaign</span></button>
    </div>
  );

  return (
    <div className="mkx-page ads">
      {bar ? createPortal(tools, bar) : null}

      {/* the board: figures and cards, each person's own */}
      <div ref={fitRef} className={`mkx-scroll is-ov mo-scroll ads-board ${editing ? "is-editing" : ""}`}>
        {live ? (
          <div className="mo">
            <HomeBoard kit={AD_KIT} className="mo-board" items={items} editing={editing} step={step} slotRef={slotRef} flash={flash}
              onOpen={() => {}} onPreview={setPreview} onChange={(next) => setDraft((d) => (d ? { ...d, items: next } : d))} onRemove={(id) => setDraft((d) => (d ? { ...d, items: d.items.filter((i) => i.id !== id) } : d))} />
            {(preview ?? items).map((it) => { const el = els[it.id]; return el && AD[it.key as AdKey] ? createPortal(card(it.key as AdKey), el, it.id) : null; })}
            {!editing && items.length === 0 && (
              <div className="mo-blank"><b>Nothing on top</b><p>Pick the figures and cards you want to see here.</p><button type="button" className="mo-btn is-main" onClick={() => { onEditing(true); setLib(true); }}>{I.plus}Add cards</button></div>
            )}
          </div>
        ) : null}
      </div>

      {/* always at the bottom: the ad campaigns (room for six at least) */}
      <section className="ads-list">
        <header className="ads-list-h">
          <b>Ad campaigns</b><em>{camps.length}</em>
          <div className="ads-seg" role="tablist" aria-label="Show">
            {(["all", "live", "paused", "draft"] as const).map((k) => {
              const n = k === "all" ? camps.length : camps.filter((c) => c.status === k).length;
              return <button key={k} role="tab" aria-selected={st === k} className={st === k ? "is-on" : ""} onClick={() => setSt(k)}>{k === "all" ? "All" : ST[k]}<i>{n}</i></button>;
            })}
          </div>
          <span className="ads-grow" />
          {pf !== "all" && <span className="ads-pfchip"><Logo pf={pf} s={14} />{PF[pf].name}<button onClick={() => setPf("all")} aria-label="Every platform">{I.x}</button></span>}
        </header>
        <div className="ads-th"><span>Campaign</span><span>Status</span><span>Budget from the wallet</span><span>Spent</span><span>Clicks</span><span>Leads</span><span>Per lead</span><span /></div>
        <div className="ads-rows">
          {shown.map((c, i) => {
            const pct = c.budget ? Math.min(100, (c.spent / c.budget) * 100) : 0;
            const left = c.budget - c.spent;
            const low = c.status === "live" && left < c.daily * 5;
            return (
              <div key={c.id} className={`ads-tr is-${c.status}`} style={{ ["--i" as string]: i } as CSSProperties}>
                <span className="ads-c"><span className="ads-c-ico"><Logo pf={c.pf} s={17} /></span><span><b>{c.name}</b><em>{PF[c.pf].name} · {c.goal} · {eur(c.daily)} a day</em></span></span>
                <span><i className={`ads-st is-${c.status}`}>{ST[c.status]}</i></span>
                <span className="ads-b">
                  <span className="ads-b-v"><b>{eur(c.budget)}</b><em>{c.budget ? `${eur(Math.max(0, left))} left` : "nothing yet"}</em>{low && <i className="ads-low">running low</i>}</span>
                  <span className="ads-bar is-sm"><i style={{ width: `${pct}%` }} /></span>
                </span>
                <span className="ads-n">{c.spent ? eur(c.spent) : "—"}</span>
                <span className="ads-n">{c.clicks ? c.clicks.toLocaleString("en-GB") : "—"}</span>
                <span className="ads-n">{c.leads || "—"}</span>
                <span className="ads-n">{c.leads ? eur(c.spent / c.leads) : "—"}</span>
                <span className="ads-acts">
                  <button className="ads-btn is-lime is-sm" onClick={() => setPanel({ k: "move", id: c.id })}>{I.wallet}Budget</button>
                  {c.status !== "draft"
                    ? <button className="ads-ico" title={c.status === "live" ? "Pause" : "Resume"} aria-label={c.status === "live" ? "Pause" : "Resume"} onClick={() => toggle(c)}>{c.status === "live" ? I.pause : I.play}</button>
                    : <button className="ads-ico" title="Delete the draft" aria-label="Delete the draft" onClick={() => remove(c)}>{I.x}</button>}
                </span>
              </div>
            );
          })}
          {!shown.length && (
            <div className="ads-empty">
              <span className="ads-empty-art" aria-hidden="true">{PF_KEYS.map((k) => <i key={k}><Logo pf={k} s={20} /></i>)}</span>
              <b>{camps.length ? "Nothing matches" : "No ad campaigns yet"}</b>
              <p>{camps.length ? "Try another platform or status." : linked.size ? "Create one, give it money from the wallet and follow what it brings." : "Connect a platform, add funds to the wallet and create your first ad campaign."}</p>
              {!camps.length && <div className="ads-empty-a">
                {wallet <= 0 && <button className="ads-btn is-ghost" onClick={() => setPanel({ k: "funds" })}>{I.plus}Add funds</button>}
                <button className="ads-btn is-pine" onClick={() => setPanel({ k: "new" })}>{I.plus}New ad campaign</button>
              </div>}
            </div>
          )}
        </div>
      </section>

      {editing && draft && createPortal(
        <div className="hb-dock mo-dock" role="toolbar" aria-label="Adjust the Ads page">
          <span className="hb-dock-t">
            <b>Adjusting Ads</b>
            <small className={noRoom || overflow ? "is-warn" : ""}>{noRoom ?? (overflow ? "Below the dashed line is off the board — make room before Done" : "Drag a card to move it · pull its edge to resize · the campaigns stay below")}</small>
          </span>
          <button type="button" className="hb-dock-add" onClick={() => setLib((v) => !v)} aria-expanded={lib}>{I.plus}Add cards</button>
          <span className="hb-dock-sep" />
          <button type="button" className="hb-dock-btn" onClick={() => setDraft({ v: 1, items: adDefault().items })} title="Back to the page everyone starts with">Reset</button>
          <button type="button" className="hb-dock-btn" onClick={() => finish(false)}>Cancel</button>
          <button type="button" className={`hb-dock-done ${overflow ? "is-off" : ""}`} onClick={() => finish(true)} aria-disabled={overflow}>Done</button>
        </div>,
        document.body,
      )}
      {editing && draft && lib && <AdLibrary onBoard={new Set(draft.items.map((i) => i.key))} onAdd={addCard} onRemove={(k) => setDraft((d) => (d ? { ...d, items: d.items.filter((i) => i.key !== k) } : d))} onClose={() => setLib(false)} />}

      {panel?.k === "funds" && <FundsPanel wallet={wallet} onClose={() => setPanel(null)} onAdd={(v) => { addFunds(v); setPanel(null); }} />}
      {panel?.k === "move" && camps.length > 0 && <MovePanel camps={camps} id={panel.id ?? (camps.find((c) => c.status === "live") ?? camps[0]).id} wallet={wallet} onPick={(id) => setPanel({ k: "move", id })} onClose={() => setPanel(null)} onMove={(id, v) => { move(id, v); setPanel(null); }} onFunds={() => setPanel({ k: "funds" })} />}
      {panel?.k === "new" && <NewPanel pf0={panel.pf} linked={linked} wallet={wallet} onConnect={connect} onClose={() => setPanel(null)} onCreate={(c) => { create(c); setPanel(null); }} />}
    </div>
  );
}

/* ---------- the card library ---------- */
function AdLibrary({ onBoard, onAdd, onRemove, onClose }: { onBoard: Set<string>; onAdd: (k: AdKey) => void; onRemove: (k: AdKey) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [grp, setGrp] = useState<AdGroup | "all">("all");
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  const f = q.trim().toLowerCase();
  const list = AD_KEYS.filter((k) => (grp === "all" || AD[k].group === grp) && (!f || `${AD[k].title} ${AD[k].hint}`.toLowerCase().includes(f)));
  return createPortal(
    <aside className="hb-lib mo-lib" role="dialog" aria-label="Add to the Ads page">
      <header className="hb-lib-h">
        <div><b>Add to Ads</b><span>The board fits above the campaigns: make room by resizing or taking a card off.</span></div>
        <button type="button" className="hb-lib-x" onClick={onClose} aria-label="Close">{I.x}</button>
      </header>
      <label className="hb-lib-q">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search cards and figures" />
      </label>
      <nav className="hb-lib-depts">
        <button type="button" className={grp === "all" ? "is-on" : ""} onClick={() => setGrp("all")}>All <i>{AD_KEYS.length}</i></button>
        {AD_GROUPS.map((g) => <button key={g} type="button" className={grp === g ? "is-on" : ""} onClick={() => setGrp(g)}><em />{g} <i>{AD_KEYS.filter((k) => AD[k].group === g).length}</i></button>)}
      </nav>
      <div className="hb-lib-list">
        {list.length === 0 && <p className="hb-lib-none">Nothing matches “{q}”.</p>}
        {AD_GROUPS.map((g) => {
          const mine = list.filter((k) => AD[k].group === g);
          if (!mine.length) return null;
          return (
            <section key={g} className="hb-lib-sec">
              <h3><em />{g}</h3>
              {mine.map((k) => {
                const on = onBoard.has(k);
                return (
                  <div key={k} className={`hb-lib-it ${on ? "is-in" : ""}`}>
                    <span className={`hb-lib-pic ${AD[k].fig ? "is-fig" : ""}`}>{AD[k].ico}</span>
                    <span className="hb-lib-txt"><b>{AD[k].title}</b><small>{AD[k].hint}</small>{on && <span className="hb-lib-where">On the page</span>}</span>
                    <span className="hb-lib-acts">{on ? <button type="button" className="is-rm" onClick={() => onRemove(k)}>Remove</button> : <button type="button" className="is-add" onClick={() => onAdd(k)}>+ Add</button>}</span>
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>
      <footer className="hb-lib-f">Your Ads page is yours: everyone arranges their own.</footer>
    </aside>,
    document.body,
  );
}

/* ---------- side panels ---------- */
function Side({ title, sub, onClose, children, foot }: { title: ReactNode; sub?: ReactNode; onClose: () => void; children: ReactNode; foot: ReactNode }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  return createPortal(
    <div className="ads-side-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="ads-side" role="dialog" aria-modal="true">
        <header className="ads-side-h"><div><h2>{title}</h2>{sub && <p>{sub}</p>}</div><button className="ads-x" onClick={onClose} aria-label="Close">{I.x}</button></header>
        <div className="ads-side-b">{children}</div>
        <footer className="ads-side-f">{foot}</footer>
      </aside>
    </div>,
    document.body,
  );
}
function Amount({ value, onChange, chips, max }: { value: number; onChange: (v: number) => void; chips: number[]; max?: number }) {
  return (
    <div className="ads-amt">
      <div className="ads-amt-in">
        <button onClick={() => onChange(Math.max(0, value - 50))} aria-label="50 € less">{I.minus}</button>
        <label><input inputMode="numeric" value={value ? String(value) : ""} placeholder="0" onChange={(e) => { const n = Number(e.target.value.replace(/\D/g, "")) || 0; onChange(max != null ? Math.min(max, n) : n); }} /><span>€</span></label>
        <button onClick={() => onChange(max != null ? Math.min(max, value + 50) : value + 50)} aria-label="50 € more">{I.plus}</button>
      </div>
      <div className="ads-chips">{chips.filter((c) => max == null || c <= max).map((c) => <button key={c} className={value === c ? "is-on" : ""} onClick={() => onChange(c)}>{eur(c)}</button>)}</div>
    </div>
  );
}
function FundsPanel({ wallet, onClose, onAdd }: { wallet: number; onClose: () => void; onAdd: (v: number) => void }) {
  const [v, setV] = useState(500);
  return (
    <Side title="Add funds" sub="One wallet pays all your ad platforms. Then you choose how much each campaign gets." onClose={onClose}
      foot={<><span className="ads-grow" /><button className="ads-btn is-ghost" onClick={onClose}>Cancel</button><button className="ads-btn is-pine" disabled={!v} onClick={() => onAdd(v)}>{I.plus}Add {eur(v)}</button></>}>
      <div className="ads-kv"><span>In the wallet now</span><b>{eur(wallet)}</b></div>
      <Amount value={v} onChange={setV} chips={[100, 250, 500, 1000, 2500]} />
      <div className="ads-kv is-after"><span>After</span><b>{eur(wallet + v)}</b></div>
      <p className="ads-note">{I.wallet}Money in the wallet is only spent by the campaigns you give it to; what a campaign doesn't use can go back to the wallet.</p>
    </Side>
  );
}
function MovePanel({ camps, id, wallet, onPick, onClose, onMove, onFunds }: { camps: Camp[]; id: string; wallet: number; onPick: (id: string) => void; onClose: () => void; onMove: (id: string, v: number) => void; onFunds: () => void }) {
  const c = camps.find((x) => x.id === id) ?? camps[0];
  const [dir, setDir] = useState<"in" | "out">("in");
  const [v, setV] = useState(Math.min(250, wallet));
  const canBack = Math.max(0, c.budget - c.spent);
  const max = dir === "in" ? wallet : canBack;
  const amt = Math.min(v, max);
  const after = c.budget + (dir === "in" ? amt : -amt);
  const days = c.daily ? Math.floor((after - c.spent) / c.daily) : null;
  const pickable = useMemo(() => camps.filter((x) => x.status !== "draft" || x.id === c.id), [camps, c.id]);
  return (
    <Side title="Campaign budget" sub="Move money between the wallet and a campaign." onClose={onClose}
      foot={<><span className="ads-grow" /><button className="ads-btn is-ghost" onClick={onClose}>Cancel</button>
        <button className="ads-btn is-pine" disabled={!amt} onClick={() => onMove(c.id, dir === "in" ? amt : -amt)}>{dir === "in" ? <>{I.arrow}Send {eur(amt)}</> : <>{I.back}Take back {eur(amt)}</>}</button></>}>
      <div className="ads-pick">
        {pickable.map((x) => (
          <button key={x.id} className={x.id === c.id ? "is-on" : ""} onClick={() => onPick(x.id)}>
            <Logo pf={x.pf} s={16} /><span><b>{x.name}</b><em>{eur(x.budget)} given · {eur(x.spent)} spent</em></span>
          </button>
        ))}
      </div>
      <div className="ads-dir" role="tablist">
        <button className={dir === "in" ? "is-on" : ""} onClick={() => setDir("in")}>Wallet → campaign</button>
        <button className={dir === "out" ? "is-on" : ""} onClick={() => setDir("out")} disabled={!canBack}>Campaign → wallet</button>
      </div>
      {dir === "in" && wallet <= 0 ? (
        <div className="ads-kv"><span>The wallet is empty</span><button className="ads-btn is-lime is-sm" onClick={onFunds}>{I.plus}Add funds</button></div>
      ) : <Amount value={amt} onChange={setV} chips={dir === "in" ? [50, 100, 250, 500, 1000] : [50, 100, 250]} max={max} />}
      <div className="ads-flow">
        <div><span>Wallet</span><b>{eur(wallet)}</b><em>→ {eur(wallet + (dir === "in" ? -amt : amt))}</em></div>
        <i>{I.arrow}</i>
        <div><span>{c.name}</span><b>{eur(c.budget)}</b><em>→ {eur(after)}</em></div>
      </div>
      {days != null && c.status !== "draft" && <p className="ads-note">{I.day}At {eur(c.daily)} a day that's about <b>{Math.max(0, days)} days</b> of ads.</p>}
    </Side>
  );
}
function NewPanel({ pf0, linked, wallet, onConnect, onClose, onCreate }: { pf0?: Pf; linked: Set<Pf>; wallet: number; onConnect: (p: Pf) => void; onClose: () => void; onCreate: (c: Camp) => void }) {
  const [pf, setPf] = useState<Pf>(pf0 ?? "linkedin");
  const [name, setName] = useState("");
  const [goal, setGoal] = useState<Goal>("Leads");
  const [daily, setDaily] = useState(25);
  const [budget, setBudget] = useState(Math.min(300, wallet));
  const on = linked.has(pf);
  const ok = !!name.trim() && on;
  const make = (status: Status) => onCreate({ id: newId(), pf, name: name.trim(), goal, status, budget: status === "draft" ? 0 : Math.min(budget, wallet), spent: 0, daily, clicks: 0, leads: 0, created: new Date().toISOString() });
  return (
    <Side title="New ad campaign" sub="Pick the platform, what you want from it and how much it gets from the wallet." onClose={onClose}
      foot={<><span className="ads-grow" /><button className="ads-btn is-ghost" disabled={!ok} onClick={() => make("draft")}>Save as draft</button><button className="ads-btn is-pine" disabled={!ok || !budget || budget > wallet} onClick={() => make("live")}>{I.play}Launch with {eur(budget)}</button></>}>
      <span className="ads-k">Platform</span>
      <div className="ads-pf-pick">
        {PF_KEYS.map((k) => (
          <button key={k} className={`${pf === k ? "is-on" : ""} ${linked.has(k) ? "" : "is-off"}`} style={{ ["--n" as string]: BRANDS[k]?.hex ?? PF[k].color } as CSSProperties} onClick={() => setPf(k)}>
            <Logo pf={k} s={22} /><b>{PF[k].name}</b><em>{linked.has(k) ? "Connected" : "Not connected"}</em>
          </button>
        ))}
      </div>
      {!on && <div className="ads-kv"><span>{PF[pf].name} isn't connected</span><button className="ads-btn is-lime is-sm" onClick={() => onConnect(pf)}>Connect</button></div>}
      <label className="ads-fld"><span className="ads-k">Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Year-end close — CFOs in Spain" /></label>
      <span className="ads-k">What you want</span>
      <div className="ads-dir">{(["Leads", "Website visits", "Awareness"] as Goal[]).map((g) => <button key={g} className={goal === g ? "is-on" : ""} onClick={() => setGoal(g)}>{g}</button>)}</div>
      <span className="ads-k">A day, at most</span>
      <Amount value={daily} onChange={setDaily} chips={[10, 25, 50, 100]} />
      <span className="ads-k">From the wallet to start <em className="ads-k-s">{eur(wallet)} in it</em></span>
      {wallet > 0 ? <Amount value={budget} onChange={setBudget} chips={[100, 250, 500, 1000]} max={wallet} />
        : <div className="ads-kv"><span>The wallet is empty — save it as a draft, or add funds first</span></div>}
      <p className="ads-note">{I.day}{budget && daily && wallet > 0 ? <>About <b>{Math.floor(Math.min(budget, wallet) / daily)} days</b> of ads · {eur(Math.max(0, wallet - budget))} stays in the wallet.</> : "Saved as a draft, nothing is spent."}</p>
    </Side>
  );
}
