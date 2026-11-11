/* =====================================================================
   BASE · Settings → Integrations
   Three lists side by side:
     Connected   — apps you already linked (with how many accounts)
     Available   — apps you can connect now (Gmail, Google Calendar, Outlook)
     Coming soon — what's on the way (request the ones you want first)
   Click any app: a detail panel opens right after its list, pushing the
   others to the right and making them narrower. For a connected app it
   shows every account: when it was connected, when it was last active, when
   mail was last read, what it's used for, Check now / Remove — and Add
   another account. For Google, until sign-in is set up, it shows the
   step-by-step setup guide.
     Gmail, Google Calendar → connected_accounts (SQL 119) via the edge function
                              "connected-accounts" (src/base/api/connectedAccounts.ts)
     Outlook                → the first account is the existing Outlook connection
                              (outlook-sync; facts from SQL 120); more go to connected_accounts
     WhatsApp Business      → the Meta login with "whatsapp": its numbers (Cloud API), a test send and
                              the latest messages (SQL 127; incoming via edge function whatsapp-webhook)
     Mailrelay              → address + API key (no sign-in window), checked and kept by
                              the edge function; its groups are read (SQL 125)
   Prefix .ig-
   ===================================================================== */
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  addAccount, addWhatsAppAccount, checkAccount, connectWhatsAppToken, connectMailrelay, LINKEDIN_PAGES, listWhatsAppMessages, sendWhatsApp, lastMailReads, listAccounts, listAssets, myOutlookConnection, providerReady, removeAccount, syncAssets,
  type ConnectedAccount, type ConnectedAsset, type OutlookFacts, type Provider, type Service, type WhatsAppMessage,
} from "../../api/connectedAccounts";
import { BRANDS } from "./brandIcons";
import "./Integrations.css";

export type OutlookProps = {
  connected: boolean | null; busy: boolean; error: string | null;
  /** Connect the first Outlook account (calendar + mail). */
  onConnect: () => void;
  /** Disconnect the first Outlook account. */
  onDisconnect: () => void;
};

/* ---------- logos ---------- */
function Logo({ k, color, letters, s = 34 }: { k?: string; color: string; letters?: string; s?: number }) {
  const b = k ? BRANDS[k] : undefined;
  return (
    <span className="ig-logo" style={{ ["--c" as string]: b?.hex ?? color, width: s, height: s }}>
      {b ? <svg viewBox="0 0 24 24" width={s * 0.52} height={s * 0.52} aria-label={b.title} role="img"><path d={b.path} fill="currentColor" /></svg>
        : <span className="ig-logo-t" style={{ fontSize: s * 0.36 }}>{letters}</span>}
    </span>
  );
}

/* ---------- catalogue ---------- */
type AppDef = {
  k: string; name: string; what: string; logo: { k?: string; color: string; letters?: string };
  live?: { provider: Provider; service: Service }; brings?: string[];
};
const LIVE: AppDef[] = [
  { k: "gmail", name: "Gmail", what: "Your Google inboxes — one sign-in also links Calendar", logo: { k: "gmail", color: "#ea4335" }, live: { provider: "google", service: "mail" },
    brings: ["Send invoices and proposals from your own Gmail", "E-mails with clients saved in their file", "As many Gmail inboxes as you need"] },
  { k: "gcal", name: "Google Calendar", what: "Your Google calendars — one sign-in also links Gmail", logo: { k: "gcal", color: "#4285f4" }, live: { provider: "google", service: "calendar" },
    brings: ["Activities you book here appear in Google Calendar", "Several calendars, one per account"] },
  { k: "outlook", name: "Outlook", what: "Mail and calendars from Microsoft 365", logo: { k: "outlook", color: "#0078d4" }, live: { provider: "microsoft", service: "mail" },
    brings: ["Calendar sync both ways", "Send invoices from your own address", "Client e-mails become contacts and tickets", "Several Outlook accounts"] },
  { k: "meta", name: "Meta", what: "Facebook pages, Instagram and Meta Ads in one sign-in", logo: { k: "meta", color: "#0467df" }, live: { provider: "meta", service: "facebook" },
    brings: ["Every Facebook page you manage", "The Instagram professional accounts linked to them", "Your Meta ad accounts and lead forms", "Several Meta logins"] },
  { k: "facebook", name: "Facebook", what: "Your Facebook pages: posts, reach and comments", logo: { k: "facebook", color: "#0866ff" }, live: { provider: "meta", service: "facebook" },
    brings: ["Publish on your pages", "Reach, reactions and comments in Growth", "Several pages"] },
  { k: "instagram", name: "Instagram", what: "Professional accounts: posts, reels and insights", logo: { k: "instagram", color: "#ff0069" }, live: { provider: "meta", service: "instagram" },
    brings: ["Publish posts and reels", "Reach, likes and comments in Growth", "Needs an Instagram business or creator account linked to a Facebook page"] },
  { k: "whatsapp", name: "WhatsApp Business", what: "Chat with clients from your business numbers", logo: { k: "whatsapp", color: "#25d366" }, live: { provider: "meta", service: "whatsapp" },
    brings: ["Your WhatsApp Business numbers (Cloud API)", "Messages clients send you, kept in the app", "Reply and send from Next", "Several numbers and accounts"] },
  { k: "linkedin", name: "LinkedIn", what: "Post as you — and as your company page once approved", logo: { k: "linkedin", color: "#0a66c2" }, live: { provider: "linkedin", service: "linkedin" },
    brings: ["Publish posts on your profile", "Company pages: post and read followers and engagement (needs LinkedIn's Community Management API)", "Several LinkedIn accounts"] },
  { k: "mailrelay", name: "Mailrelay", what: "E-mail marketing: groups, subscribers and newsletters", logo: { color: "#1f6fd1", letters: "Mr" }, live: { provider: "mailrelay", service: "mailrelay" },
    brings: ["Your Mailrelay groups and how many subscribers each has", "New clients and contacts can go into a group", "Newsletters and their results in Growth", "Several Mailrelay accounts"] },
];
const SOON: AppDef[] = [
  { k: "messenger", name: "Messenger", what: "Facebook and Instagram DMs in one inbox", logo: { k: "messenger", color: "#0866ff" }, brings: ["Every DM in one inbox", "Replies kept on the client"] },
  { k: "linkedin-ads", name: "LinkedIn Ads", what: "Campaigns and lead-gen forms", logo: { k: "linkedin", color: "#0a66c2" }, brings: ["LinkedIn Ads campaigns and results", "Lead-gen forms into Orbit"] },
  { k: "tiktok", name: "TikTok", what: "Short videos and TikTok Ads", logo: { k: "tiktok", color: "#000" }, brings: ["Publish short videos", "TikTok Ads results"] },
  { k: "gads", name: "Google Ads", what: "Search and display campaigns", logo: { k: "gads", color: "#4285f4" }, brings: ["Campaigns with cost per lead", "Spend next to the deals it brought"] },
  { k: "youtube", name: "YouTube", what: "Videos, views and subscribers", logo: { k: "youtube", color: "#ff0000" }, brings: ["Upload videos", "Views and subscribers in Growth"] },
  { k: "x", name: "X", what: "Posts and engagement", logo: { k: "x", color: "#000" }, brings: ["Publish posts", "Read engagement"] },
  { k: "ga", name: "Google Analytics", what: "Website visitors and sources", logo: { k: "ga", color: "#e37400" }, brings: ["Visitors and where they come from", "Which pages bring leads"] },
  { k: "gbp", name: "Google Business Profile", what: "Reviews and your Maps listing", logo: { k: "google", color: "#4285f4" }, brings: ["Your reviews in one place", "Your Google Maps listing"] },
  { k: "web", name: "Your website", what: "Site forms become leads in Orbit", logo: { color: "#0f9f6e", letters: "</>" }, brings: ["Each form sent creates the company, contact and deal"] },
];
const APP = Object.fromEntries([...LIVE, ...SOON].map((a) => [a.k, a])) as Record<string, AppDef>;
const WANT_KEY = "next.base.integrations.want";
const SVC: Record<Service, string> = { mail: "Mail", calendar: "Calendar", facebook: "Facebook", instagram: "Instagram", ads: "Ads", linkedin: "Profile posts", linkedin_pages: "Company pages", mailrelay: "E-mail marketing", whatsapp: "WhatsApp" };
/** Which apps of the list an account shows under. */
const appsOf = (a: ConnectedAccount): string[] =>
  a.provider === "google" ? a.services.map((s) => (s === "mail" ? "gmail" : s === "calendar" ? "gcal" : "")).filter(Boolean)
  : a.provider === "meta" ? [...(a.services.some((s) => s !== "whatsapp") ? ["meta"] : []), ...(a.services.includes("facebook") ? ["facebook"] : []), ...(a.services.includes("instagram") ? ["instagram"] : []), ...(a.services.includes("whatsapp") ? ["whatsapp"] : [])]
  : a.provider === "linkedin" ? ["linkedin"]
  : a.provider === "mailrelay" ? ["mailrelay"]
  : ["outlook"];
/** What one sign-in asks for, per app. */
const servicesFor = (k: string): Service[] =>
  k === "meta" ? ["facebook", "instagram", "ads"] : k === "facebook" ? ["facebook"] : k === "instagram" ? ["instagram"] : k === "whatsapp" ? ["whatsapp"]
  : k === "linkedin" ? (LINKEDIN_PAGES ? ["linkedin", "linkedin_pages"] : ["linkedin"]) : k === "mailrelay" ? ["mailrelay"] : ["mail", "calendar"];
const colorOf = (a: AppDef) => BRANDS[a.logo.k ?? ""]?.hex ?? a.logo.color;

type Row = {
  key: string; app: string; id: string; email: string; label?: string | null; provider?: Provider; services: Service[]; status: "active" | "error"; note?: string | null;
  primary?: boolean; connectedAt?: string | null; lastActive?: string | null;
};
type Col = "mine" | "avail" | "soon";

/* ---------- dates ---------- */
const fmtDate = (iso?: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) + ", " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
};
const ago = (iso?: string | null) => {
  if (!iso) return "Not yet";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? "Yesterday" : d < 30 ? `${d} days ago` : fmtDate(iso);
};

export default function Integrations({ onBack, outlook }: { onBack: () => void; outlook: OutlookProps }) {
  const [want, setWant] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(WANT_KEY) || "[]"); } catch { return []; } });
  useEffect(() => { try { localStorage.setItem(WANT_KEY, JSON.stringify(want)); } catch { /* ignore */ } }, [want]);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<{ col: Col; app: string } | null>(null);

  const [accounts, setAccounts] = useState<ConnectedAccount[] | null>(null);
  const [ol, setOl] = useState<OutlookFacts | null>(null);
  const [reads, setReads] = useState<Record<string, string>>({});
  const [assets, setAssets] = useState<ConnectedAsset[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [err, setErr] = useState<{ k: string; text: string } | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(""), 2600); return () => clearTimeout(t); }, [toast]);

  const reload = useCallback(async () => {
    const [r, m, as] = await Promise.all([listAccounts(), lastMailReads().catch(() => ({})), listAssets().catch(() => [])]);
    setAccounts(r.accounts); setReads(m); setAssets(as);
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    if (!outlook.connected) { setOl(null); return; }
    myOutlookConnection().then(setOl).catch(() => setOl(null));
  }, [outlook.connected]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") setSel(null); };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, []);

  /* every account, per app */
  const rows: Row[] = [];
  if (outlook.connected) rows.push({ key: "outlook:primary", app: "outlook", id: "outlook-primary", email: ol?.email ?? "Outlook account", services: ["mail", "calendar"], status: "active", primary: true, connectedAt: ol?.connectedAt, lastActive: ol?.lastRefresh });
  for (const a of accounts ?? []) {
    const base = { id: a.id, email: a.email, label: a.provider === "meta" || a.provider === "linkedin" ? a.display_name : null, provider: a.provider, status: a.status, note: a.last_error, connectedAt: a.connected_at, lastActive: a.updated_at ?? a.connected_at };
    if (a.provider === "microsoft" && a.email === ol?.email) continue;
    for (const app of appsOf(a)) rows.push({ ...base, key: `${app}:${a.id}`, app, services: a.provider === "google" ? [app === "gmail" ? "mail" : "calendar"] : a.services });
  }
  const rowsOf = (k: string) => rows.filter((r) => r.app === k);
  const mine = LIVE.filter((a) => rowsOf(a.k).length > 0);

  /* ---- a newly connected app's logo flies into the Connected list ---- */
  const fly = useRef<{ app: string; rect: DOMRect } | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<string[]>([]);
  const mineRef = useRef<HTMLDivElement>(null);
  const appKeys = mine.map((a) => a.k).join("|");
  const rowKeys = rows.map((r) => r.key).join("|");
  useLayoutEffect(() => {
    const now = new Set(rows.map((r) => r.key));
    if (seen.current === null) { if (accounts !== null && outlook.connected !== null) seen.current = now; return; }
    const added = rows.filter((r) => !seen.current!.has(r.key));
    seen.current = now;
    if (!added.length) return;
    setFresh(added.map((r) => r.key).concat(added.map((r) => `app:${r.app}`)));
    window.setTimeout(() => setFresh([]), 1500);
    const f = fly.current; fly.current = null;
    const dest = f && mineRef.current?.querySelector<HTMLElement>(`[data-app="${f.app}"] .ig-logo`);
    if (!f || !dest || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const to = dest.getBoundingClientRect();
    const ghost = dest.cloneNode(true) as HTMLElement;
    Object.assign(ghost.style, { position: "fixed", left: `${f.rect.left}px`, top: `${f.rect.top}px`, width: `${f.rect.width}px`, height: `${f.rect.height}px`, margin: "0", zIndex: "400", pointerEvents: "none" });
    document.body.appendChild(ghost);
    dest.style.opacity = "0";
    const dx = to.left - f.rect.left, dy = to.top - f.rect.top, sc = to.width / f.rect.width;
    const anim = ghost.animate([
      { transform: "translate(0,0) scale(1)" },
      { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 70}px) scale(${(1 + sc) / 2 + 0.15})` },
      { transform: `translate(${dx}px, ${dy}px) scale(${sc})` },
    ], { duration: 760, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
    anim.onfinish = () => { ghost.remove(); dest.style.opacity = ""; dest.animate([{ transform: "scale(1.25)" }, { transform: "scale(1)" }], { duration: 380, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" }); };
  }, [rowKeys, appKeys, accounts === null, outlook.connected === null]); // eslint-disable-line react-hooks/exhaustive-deps

  /* account cards start collapsed; a just-connected one opens */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleAcc = (k: string) => setExpanded((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  useEffect(() => { if (fresh.length) setExpanded((s) => new Set([...s, ...fresh.filter((k) => !k.startsWith("app:"))])); }, [fresh]);
  const KIND_OF: Record<string, ConnectedAsset["kind"] | undefined> = { facebook: "facebook_page", instagram: "instagram", whatsapp: "whatsapp_number" };
  const assetsFor = (r: Row, app: string) => assets.filter((x) => x.account_id === r.id && (KIND_OF[app] ? x.kind === KIND_OF[app] : x.kind !== "whatsapp_number"));
  const summaryOf = (r: Row, app: string) => {
    const n = assetsFor(r, app).length;
    const what = r.provider === "meta" ? (app === "whatsapp" ? `${n} number${n === 1 ? "" : "s"}` : `${n} page${n === 1 ? "" : "s"} & accounts`)
      : r.provider === "mailrelay" ? `${n} group${n === 1 ? "" : "s"}` : r.services.map((s) => SVC[s]).join(" · ");
    return `${what} · active ${ago(r.lastActive).toLowerCase()}`;
  };

  /* WhatsApp: add an account by its ID (Meta's test account isn't owned by your business) */
  const addWaba = async (r: Row, waba: string): Promise<string | null> => {
    const x = await addWhatsAppAccount(r.id, waba);
    if (x.error) return x.error;
    await reload(); void loadWa();
    setToast(`${x.numbers} WhatsApp number${x.numbers === 1 ? "" : "s"} added`);
    return null;
  };

  /* WhatsApp: latest messages of your numbers */
  const [waMsgs, setWaMsgs] = useState<WhatsAppMessage[]>([]);
  const loadWa = useCallback(async () => setWaMsgs(await listWhatsAppMessages(60).catch(() => [])), []);
  useEffect(() => { if (sel?.app === "whatsapp") void loadWa(); }, [sel?.app, loadWa]);

  const connect = async (a: AppDef, from: HTMLElement | null) => {
    setErr(null);
    const logo = from?.closest(".ig-det")?.querySelector<HTMLElement>(".ig-det-h .ig-logo");
    if (logo) fly.current = { app: a.k, rect: logo.getBoundingClientRect() };
    if (a.k === "outlook" && !outlook.connected) { outlook.onConnect(); return; }
    if (!a.live) return;
    setBusy(a.k);
    // one Google / Microsoft sign-in covers mail and calendar; Meta asks what that app needs
    const r = await addAccount(a.live.provider, servicesFor(a.k));
    setBusy(null);
    if (r.error) { fly.current = null; setErr({ k: a.k, text: r.error }); return; }
    await reload();
    const got = r.assets && !r.assets.error ? (a.k === "whatsapp" ? ` · ${(r.assets as any).whatsapp ?? 0} WhatsApp numbers` : ` · ${r.assets.pages ?? 0} pages, ${r.assets.instagram ?? 0} Instagram`) : "";
    setToast(`${r.account?.display_name || r.account?.email || "Account"} connected${got}`);
  };
  /** Mailrelay: address + API key from the form in the panel. */
  const connectKey = async (a: AppDef, account: string, apiKey: string, from: HTMLElement | null): Promise<boolean> => {
    setErr(null);
    const logo = from?.closest(".ig-det")?.querySelector<HTMLElement>(".ig-det-h .ig-logo");
    if (logo) fly.current = { app: a.k, rect: logo.getBoundingClientRect() };
    setBusy(a.k);
    const r = await connectMailrelay(account, apiKey);
    setBusy(null);
    if (r.error) { fly.current = null; setErr({ k: a.k, text: r.error }); return false; }
    await reload();
    const g = r.assets && !r.assets.error && r.assets.groups != null ? ` · ${r.assets.groups} group${r.assets.groups === 1 ? "" : "s"}` : "";
    setToast(`${r.account?.email ?? "Mailrelay"} connected${g}`);
    return true;
  };
  /** An account already linked for another app of the same provider: turn this app on for it (one consent). */
  const enableFor = async (a: AppDef, acc: ConnectedAccount) => {
    setErr(null); setBusy(`${a.k}:${acc.id}`);
    const r = await addAccount(acc.provider, Array.from(new Set([...acc.services, ...servicesFor(a.k)])), { loginHint: acc.provider === "google" ? acc.email : "rerequest" });
    setBusy(null);
    if (r.error) { setErr({ k: a.k, text: r.error }); return; }
    await reload();
    setToast(`${a.name} on for ${acc.display_name || acc.email}`);
  };
  const remove = async (r: Row) => {
    setAsking(null);
    if (r.primary) { outlook.onDisconnect(); return; }
    const e = await removeAccount(r.id);
    if (e) { setErr({ k: r.app, text: e }); return; }
    await reload();
    setToast(`${r.email} removed`);
  };
  const resync = async (r: Row) => {
    setChecking(`sync:${r.key}`);
    const x = await syncAssets(r.id);
    setChecking(null);
    await reload();
    setToast(x.error ? `Couldn't read ${r.provider === "mailrelay" ? "groups" : "pages"}: ${x.error}` : r.provider === "mailrelay" ? "Groups updated" : "Pages and accounts updated");
  };
  const check = async (r: Row) => {
    setChecking(r.key);
    const c = await checkAccount(r.id);
    setChecking(null);
    await reload();
    setToast(c.status === "active" ? `${r.email} works` : `${r.email}: ${c.error ?? "sign in again"}`);
  };

  const needle = q.trim().toLowerCase();
  const match = (a: AppDef) => !needle || `${a.name} ${a.what}`.toLowerCase().includes(needle);
  const loading = accounts === null || outlook.connected === null;
  const open = (col: Col, k: string) => setSel((s) => (s && s.col === col && s.app === k ? null : { col, app: k }));

  const list = (col: Col, apps: AppDef[], sub: (a: AppDef) => string) => (
    <ul className="ig-list">
      {apps.filter(match).map((a, i) => {
        const on = sel?.col === col && sel.app === a.k;
        const n = rowsOf(a.k).length;
        const bad = rowsOf(a.k).some((r) => r.status === "error");
        return (
          <li key={a.k} data-app={a.k} style={{ ["--i" as string]: i, ["--c" as string]: colorOf(a) }}
            className={`ig-item ${on ? "is-on" : ""} ${fresh.includes(`app:${a.k}`) && col === "mine" ? "is-fresh" : ""} ${col === "soon" && want.includes(a.k) ? "is-want" : ""}`}>
            <button onClick={() => open(col, a.k)} aria-expanded={on}>
              <Logo {...a.logo} s={36} />
              <span className="ig-item-txt"><b>{a.name}</b><small>{sub(a)}</small></span>
              {col === "mine" && <span className={`ig-dot ${bad ? "is-err" : ""}`} />}
              {col === "soon" && want.includes(a.k) && <span className="ig-req"><Check /></span>}
              {col === "avail" && n > 0 && <span className="ig-badge">{n}</span>}
              <span className="ig-chev"><Chev /></span>
            </button>
          </li>
        );
      })}
    </ul>
  );

  const detail = (col: Col) => {
    const isOpen = sel?.col === col;
    const a = isOpen ? APP[sel!.app] : null;
    return (
      <aside className={`ig-det ${isOpen ? "is-open" : ""}`} aria-hidden={!isOpen} style={a ? { ["--c" as string]: colorOf(a) } : undefined}>
        {a && (
          <div className="ig-det-in" key={`${col}:${a.k}`}>
            <header className="ig-det-h">
              <Logo {...a.logo} s={48} />
              <div><h3>{a.name}{a.brings && a.live && <Info items={a.brings} />}</h3><p>{a.what}</p></div>
              <button className="ig-x" onClick={() => setSel(null)} aria-label="Close"><X /></button>
            </header>
            {a.live ? liveDetail(a) : soonDetail(a)}
          </div>
        )}
      </aside>
    );
  };

  function liveDetail(a: AppDef) {
    const rs = rowsOf(a.k);
    const ready = a.k === "outlook" || providerReady(a.live!.provider);
    const isBusy = busy === a.k || (a.k === "outlook" && !!outlook.busy);
    const error = err?.k === a.k ? err.text : a.k === "outlook" && !outlook.connected ? outlook.error : null;
    return (
      <>
        <div className="ig-det-sec">
          <h4>{rs.length ? `Accounts · ${rs.length}` : "No account yet"}</h4>
          {rs.map((r) => (
            <article key={r.key} className={`ig-acc ${r.status === "error" ? "is-err" : ""} ${fresh.includes(r.key) ? "is-fresh" : ""} ${expanded.has(r.key) ? "is-open" : ""}`}>
              <button className="ig-acc-h" onClick={() => toggleAcc(r.key)} aria-expanded={expanded.has(r.key)}>
                <i className="ig-av">{(r.label || r.email)[0]?.toUpperCase()}</i>
                <span className="ig-acc-name"><b title={r.email}>{r.label || r.email}</b><small>{summaryOf(r, a.k)}</small></span>
                <span className={`ig-pill ${r.status === "error" ? "is-err" : ""}`}>{r.status === "error" ? "Needs sign-in" : "Working"}</span>
                <span className="ig-acc-chev"><Chev /></span>
              </button>
              <div className="ig-acc-body"><div className="ig-acc-in">
              <dl className="ig-facts">
                <div><dt>Connected</dt><dd>{fmtDate(r.connectedAt)}</dd></div>
                <div><dt>Last active</dt><dd title={fmtDate(r.lastActive)}>{ago(r.lastActive)}</dd></div>
                {r.services.includes("mail") && <div><dt>Last mail read</dt><dd title={fmtDate(reads[r.email.toLowerCase()])}>{ago(reads[r.email.toLowerCase()])}</dd></div>}
                <div><dt>Used for</dt><dd>{r.services.map((s) => SVC[s]).join(" · ")}{r.primary ? " · main" : ""}</dd></div>
              </dl>
              {r.provider === "meta" && !(a.k === "whatsapp" && assetsFor(r, a.k).length === 0) && <AssetList items={assetsFor(r, a.k)} />}
              {r.provider === "meta" && a.k === "whatsapp" && assetsFor(r, a.k).length === 0 && <WaAdd onAdd={(waba) => addWaba(r, waba)} />}
              {r.provider === "meta" && a.k === "whatsapp" && assetsFor(r, a.k).length > 0 && <WaPanel numbers={assetsFor(r, a.k)} messages={waMsgs} onSent={() => void loadWa()} />}
              {r.provider === "linkedin" && r.services.includes("linkedin_pages") && <AssetList items={assets.filter((x) => x.account_id === r.id)} />}
              {r.provider === "mailrelay" && <AssetList items={assets.filter((x) => x.account_id === r.id)} none="No groups in this account yet." />}
              {r.status === "error" && r.note && <p className="ig-acc-err">{r.note}</p>}
              <div className="ig-acc-act">
                {!r.primary && <button className="ig-mini" disabled={checking === r.key} onClick={() => void check(r)}>{checking === r.key ? <span className="ig-spin is-dark" /> : <Refresh />}Check now</button>}
                {(r.provider === "meta" || r.provider === "mailrelay" || (r.provider === "linkedin" && r.services.includes("linkedin_pages"))) && <button className="ig-mini" disabled={checking === `sync:${r.key}`} onClick={() => void resync(r)}>{checking === `sync:${r.key}` ? <span className="ig-spin is-dark" /> : <Refresh />}{r.provider === "mailrelay" ? "Re-read groups" : a.k === "whatsapp" ? "Re-read numbers" : "Re-read pages"}</button>}
                <span className="ig-grow" />
                {asking === r.key ? (
                  <span className="ig-ask"><span>Remove this account?</span><button className="is-yes" onClick={() => void remove(r)}>Remove</button><button onClick={() => setAsking(null)}>Keep</button></span>
                ) : <button className="ig-mini is-danger" onClick={() => setAsking(r.key)}>Remove</button>}
              </div>
              </div></div>
            </article>
          ))}
          {(a.live!.provider === "google" || a.live!.provider === "meta") && (accounts ?? []).filter((x) => x.provider === a.live!.provider && !appsOf(x).includes(a.k)).map((x) => (
            <div key={x.id} className="ig-also">
              <i className="ig-av">{(x.display_name || x.email)[0]?.toUpperCase()}</i>
              <span><b>{x.provider === "meta" ? x.display_name || x.email : x.email}</b><small>Linked for {appsOf(x).map((k) => APP[k]?.name).join(" & ")} — not for {a.name} yet</small></span>
              <button className="ig-mini" disabled={busy === `${a.k}:${x.id}`} onClick={() => void enableFor(a, x)}>
                {busy === `${a.k}:${x.id}` ? <span className="ig-spin is-dark" /> : <Plus />}Use here
              </button>
            </div>
          ))}
          {error && <p className="ig-det-err">{error}</p>}
          {a.live!.provider === "mailrelay" ? (
            <KeyForm key={rs.length} open={!rs.length} more={rs.length > 0} busy={isBusy} onSubmit={(acc, key, el) => connectKey(a, acc, key, el)} />
          ) : <button className={`ig-brand-btn ${rs.length ? "is-soft" : ""}`} disabled={!ready || isBusy || loading} onClick={(e) => void connect(a, e.currentTarget)}>
            {isBusy ? <span className="ig-spin" /> : <Plus />}{isBusy ? "Waiting for sign-in…" : rs.length ? "Add another account" : `Connect ${a.name}`}
          </button>}
        </div>
        {a.live!.provider === "google" && !providerReady("google") && <Fold title="Set up Google sign-in" sub="once · about 10 min" open><GoogleGuide /></Fold>}
        {a.live!.provider === "meta" && !providerReady("meta") && <Fold title="Set up Meta sign-in" sub="once · about 15 min" open><MetaGuide /></Fold>}
        {a.live!.provider === "linkedin" && !providerReady("linkedin") && <Fold title="Set up LinkedIn sign-in" sub="once · about 10 min" open><LinkedInGuide /></Fold>}
        {a.live!.provider === "mailrelay" && <Fold title="Where to find the API key" sub="1 min" open={!rs.length}><MailrelayGuide /></Fold>}
        {a.k === "whatsapp" && <Fold title="Connect with a system user token" sub="your own business · no sign-in window" open={!rs.some((r) => assetsFor(r, "whatsapp").length)}><WaTokenForm onDone={async (n) => { await reload(); void loadWa(); setToast(`WhatsApp connected · ${n} number${n === 1 ? "" : "s"}`); }} /></Fold>}
        {a.k === "whatsapp" && providerReady("meta") && <Fold title="How to set up WhatsApp" sub="Meta app, number, webhook"><WhatsAppGuide /></Fold>}
        {a.live!.provider === "linkedin" && providerReady("linkedin") && !LINKEDIN_PAGES && <p className="ig-det-p ig-det-pad">Company pages turn on once LinkedIn approves the Community Management API for this app.</p>}
      </>
    );
  }

  function soonDetail(a: AppDef) {
    const on = want.includes(a.k);
    return (
      <>
        <div className="ig-det-sec">
          <span className="ig-soon-tag">Coming soon</span>
          <h4>What it will do</h4>
          <ul className="ig-brings">{(a.brings ?? [a.what]).map((b) => <li key={b}><Check />{b}</li>)}</ul>
        </div>
        <div className="ig-det-sec">
          <p className="ig-det-p">Tell us you want it — the most requested integrations are built first.</p>
          <button className={`ig-brand-btn ${on ? "is-soft" : ""}`} onClick={() => setWant((w) => (w.includes(a.k) ? w.filter((x) => x !== a.k) : [...w, a.k]))}>
            {on ? <><Check />Requested — tap to undo</> : <><Bell />Notify me when it's ready</>}
          </button>
        </div>
      </>
    );
  }

  const squeezed = !!sel;
  return (
    <div className="ig">
      <header className="ig-head">
        <button className="ig-back" onClick={onBack} aria-label="Back to Settings">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
        </button>
        <div className="ig-head-txt">
          <h1>Integrations</h1>
          <p>Connect the apps you work with — as many accounts as you need</p>
        </div>
        <label className="ig-search">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an app" />
        </label>
      </header>

      <div className={`ig-cols ${squeezed ? "is-squeezed" : ""}`}>
        <section className="ig-col" ref={mineRef}>
          <header className="ig-col-h"><h2>Connected</h2><span className="ig-n">{rows.length}</span></header>
          {loading ? <div className="ig-skel"><i /><i /></div> : mine.length === 0 ? (
            <div className="ig-empty"><span className="ig-empty-art" aria-hidden="true"><i /><i /><i /></span><b>Nothing connected yet</b><small>Pick an app in Available.</small></div>
          ) : list("mine", mine, (a) => { const n = rowsOf(a.k).length; return `${n} account${n === 1 ? "" : "s"}`; })}
        </section>
        {detail("mine")}

        <section className="ig-col">
          <header className="ig-col-h"><h2>Available</h2><span className="ig-n is-soft">{LIVE.length}</span></header>
          {list("avail", LIVE, (a) => (a.k === "outlook" || providerReady(a.live!.provider) ? a.what : `Set up ${a.live!.provider === "meta" ? "Meta" : a.live!.provider === "linkedin" ? "LinkedIn" : "Google"} sign-in first`))}
        </section>
        {detail("avail")}

        <section className="ig-col">
          <header className="ig-col-h"><h2>Coming soon</h2><span className="ig-n is-soft">{SOON.length}</span></header>
          {list("soon", SOON, (a) => (want.includes(a.k) ? "Requested" : a.what))}
        </section>
        {detail("soon")}
      </div>

      {toast && <div className="ig-toast"><Check />{toast}</div>}
    </div>
  );
}

/* ---------- "What it does", on hover / focus of the ⓘ next to the name ---------- */
function Info({ items, soon }: { items: string[]; soon?: boolean }) {
  return (
    <span className="ig-info">
      <button type="button" className="ig-info-b" aria-label={soon ? "What it will do" : "What it does"}>i</button>
      <span className="ig-info-pop" role="tooltip">
        <b>{soon ? "What it will do" : "What it does"}</b>
        <ul>{items.map((t, i) => <li key={t} style={{ ["--i" as string]: i }}><Check />{t}</li>)}</ul>
      </span>
    </span>
  );
}

/* ---------- a section that folds away (setup guides) ---------- */
function Fold({ title, sub, open: start = false, children }: { title: string; sub?: string; open?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(start);
  return (
    <div className={`ig-fold ${open ? "is-open" : ""}`}>
      <button className="ig-fold-h" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="ig-fold-ic"><Book /></span>
        <span className="ig-fold-t"><b>{title}</b>{sub && <small>{sub}</small>}</span>
        <span className="ig-acc-chev"><Chev /></span>
      </button>
      <div className="ig-fold-body"><div className="ig-fold-in">{children}</div></div>
    </div>
  );
}

/* ---------- WhatsApp: system-user token + account ID ---------- */
function WaTokenForm({ onDone }: { onDone: (numbers: number) => void }) {
  const [tok, setTok] = useState("");
  const [waba, setWaba] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ok = tok.trim().length >= 40 && waba.replace(/\D/g, "").length >= 6;
  return (
    <div className="ig-guide ig-wa-tok">
      <ol>
        <li><b>Create a system user</b><span>business.facebook.com → <i>Settings → Users → System users → Add</i> → name “Next”, role <i>Admin</i>.</span></li>
        <li><b>Give it the WhatsApp account</b><span><i>Assign assets → WhatsApp accounts</i> → your account (the test one too) → <i>Full control</i>. Also <i>Apps</i> → “Next”.</span></li>
        <li><b>Generate the token</b><span><i>Generate token</i> → app “Next”, expiry <i>Never</i>, permissions <i>whatsapp_business_management</i> and <i>whatsapp_business_messaging</i>. Copy it.</span></li>
        <li><b>The account ID</b><span>Meta app → <i>WhatsApp → API setup</i> → “WhatsApp Business account ID”.</span></li>
      </ol>
      <form className="ig-key" onSubmit={async (e) => { e.preventDefault(); if (!ok || busy) return; setBusy(true); setErr(null); const r = await connectWhatsAppToken(tok, waba); setBusy(false); if (r.error) setErr(r.error); else { setTok(""); setWaba(""); onDone(r.numbers ?? 0); } }}>
        <label className="ig-fld"><span>System user token</span><span className="ig-fld-in"><input type="password" value={tok} onChange={(e) => setTok(e.target.value)} placeholder="EAA…" autoComplete="new-password" spellCheck={false} /></span></label>
        <label className="ig-fld"><span>WhatsApp Business account ID</span><span className="ig-fld-in"><input value={waba} onChange={(e) => setWaba(e.target.value)} placeholder="e.g. 1114103584841887" inputMode="numeric" /></span></label>
        <p className="ig-key-note"><Lock />Checked with Meta and kept on the server — it never comes back to this page.</p>
        <button type="submit" className="ig-brand-btn" disabled={!ok || busy}>{busy ? <span className="ig-spin" /> : <Plus />}{busy ? "Checking…" : "Connect WhatsApp"}</button>
        {err && <p className="ig-det-err">{err}</p>}
      </form>
    </div>
  );
}

/* ---------- WhatsApp: add an account by ID ---------- */
function WaAdd({ onAdd }: { onAdd: (waba: string) => Promise<string | null> }) {
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ok = v.replace(/\D/g, "").length >= 6;
  return (
    <form className="ig-wa-add" onSubmit={async (e) => { e.preventDefault(); if (!ok || busy) return; setBusy(true); setErr(null); const x = await onAdd(v); setBusy(false); if (x) setErr(x); else setV(""); }}>
      <p className="ig-wa-add-note">No WhatsApp number found for this login. Paste the <b>WhatsApp Business account ID</b> (Meta app → WhatsApp → API setup).</p>
      <div className="ig-wa-add-row">
        <span className="ig-fld-in"><input value={v} onChange={(e) => setV(e.target.value)} placeholder="e.g. 1114103584841887" inputMode="numeric" /></span>
        <button type="submit" className="ig-mini" disabled={!ok || busy}>{busy ? <span className="ig-spin is-dark" /> : <Plus />}Add</button>
      </div>
      {err && <p className="ig-acc-err">{err}</p>}
    </form>
  );
}

/* ---------- WhatsApp: send a test and the latest messages ---------- */
function WaPanel({ numbers, messages, onSent }: { numbers: ConnectedAsset[]; messages: WhatsAppMessage[]; onSent: () => void }) {
  const [from, setFrom] = useState(numbers[0]?.id ?? "");
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const [tpl, setTpl] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; t: string } | null>(null);
  const num = numbers.find((n) => n.id === from) ?? numbers[0];
  const mine = messages.filter((m) => numbers.some((n) => n.external_id === m.phone_number_id)).slice(0, 6);
  const send = async () => {
    setBusy(true); setNote(null);
    const r = await sendWhatsApp(num.id, to, tpl ? { template: "hello_world", lang: "en_US" } : { text });
    setBusy(false);
    setNote(r.error ? { ok: false, t: r.error } : { ok: true, t: "Sent" });
    if (!r.error) { setText(""); onSent(); }
  };
  return (
    <div className="ig-wa">
      <h5>Send a test</h5>
      {numbers.length > 1 && (
        <select className="ig-wa-sel" value={from} onChange={(e) => setFrom(e.target.value)}>
          {numbers.map((n) => <option key={n.id} value={n.id}>{n.username || n.external_id}{n.name ? ` · ${n.name}` : ""}</option>)}
        </select>
      )}
      <div className="ig-fld-in"><input value={to} onChange={(e) => setTo(e.target.value)} placeholder="To: 34600111222 (with country code)" inputMode="tel" /></div>
      <div className="ig-wa-seg">
        <button className={tpl ? "is-on" : ""} onClick={() => setTpl(true)}>"Hello world" template</button>
        <button className={!tpl ? "is-on" : ""} onClick={() => setTpl(false)}>Free text</button>
      </div>
      {!tpl && <div className="ig-fld-in"><input value={text} onChange={(e) => setText(e.target.value)} placeholder="Message" /></div>}
      <p className="ig-key-note">{tpl ? "A template can start a conversation with anyone." : "Free text only reaches people who wrote to this number in the last 24 hours."}</p>
      <button className="ig-brand-btn" disabled={busy || to.replace(/\D/g, "").length < 8 || (!tpl && !text.trim())} onClick={() => void send()}>
        {busy ? <span className="ig-spin" /> : <Send />}{busy ? "Sending…" : "Send"}
      </button>
      {note && <p className={note.ok ? "ig-wa-ok" : "ig-det-err"}>{note.t}</p>}
      <h5>Latest messages</h5>
      {mine.length === 0 ? <p className="ig-assets-none">Nothing yet — messages people send to your number appear here.</p> : (
        <ul className="ig-wa-msgs">
          {mine.map((m) => (
            <li key={m.id} className={`is-${m.direction}`}>
              <span><b>{m.direction === "in" ? m.contact_name || `+${m.contact_phone}` : `To +${m.contact_phone}`}</b><small>{ago(m.created_at)}{m.direction === "out" && m.status ? ` · ${m.status}` : ""}</small></span>
              <p>{m.body || `[${m.type}]`}</p>
              {m.error && <em>{m.error}</em>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
function WhatsAppGuide() {
  const hook = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/whatsapp-webhook`;
  const [copied, setCopied] = useState("");
  const copy = (t: string) => { void navigator.clipboard?.writeText(t); setCopied(t); setTimeout(() => setCopied(""), 1400); };
  return (
    <div className="ig-det-sec ig-guide">
      <h4>Set up WhatsApp · once</h4>
      <ol>
        <li><b>Add WhatsApp to the Meta app</b><span>developers.facebook.com → your app → <i>Use cases → Add</i> → <i>Connect with customers through WhatsApp</i>.</span></li>
        <li><b>A number</b><span>In <i>WhatsApp → API setup</i> Meta gives a free test number. For your own, add it in <i>WhatsApp Manager</i> — it can't be in use in the WhatsApp app at the same time.</span></li>
        <li><b>Receive messages</b><span><i>WhatsApp → Configuration → Webhook → Edit</i>. Callback URL:</span>
          <button className={`ig-code ${copied === hook ? "is-done" : ""}`} onClick={() => copy(hook)}>{hook}{copied === hook ? <Check /> : <Copy />}</button>
          <span>Verify token: the value saved in Supabase as <i>WHATSAPP_VERIFY_TOKEN</i>. Then <i>Manage</i> → subscribe <i>messages</i>.</span></li>
        <li><b>Share it with Next</b><span>In <i>Facebook Login for Business → Configurations</i> edit “Next” and tick <i>WhatsApp accounts</i>.</span></li>
        <li><b>Connect</b><span>Press <i>Connect WhatsApp Business</i>, pick your business and WhatsApp account, accept.</span></li>
      </ol>
    </div>
  );
}

/* ---------- Mailrelay: address + API key ---------- */
function KeyForm({ open: startOpen, more, busy, onSubmit }: { open: boolean; more: boolean; busy: boolean; onSubmit: (account: string, key: string, el: HTMLElement | null) => Promise<boolean> }) {
  const [open, setOpen] = useState(startOpen);
  const [acc, setAcc] = useState("");
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLFormElement>(null);
  const host = acc.trim().toLowerCase().replace(/^https?:\/\//, "").split(/[/?#:]/)[0];
  const full = host && !host.includes(".") ? `${host}.ipzmarketing.com` : host;
  const ok = !!full && key.trim().length >= 8;
  if (!open) return (
    <button className="ig-brand-btn is-soft" onClick={() => setOpen(true)}><Plus />Add another account</button>
  );
  return (
    <form ref={ref} className="ig-key" onSubmit={async (e) => { e.preventDefault(); if (!ok || busy) return; if (await onSubmit(acc, key, ref.current)) { setKey(""); setAcc(""); if (more) setOpen(false); } }}>
      <label className="ig-fld">
        <span>Account address</span>
        <span className="ig-fld-in">
          <input value={acc} onChange={(e) => setAcc(e.target.value)} placeholder="yourcompany" autoComplete="off" spellCheck={false} />
          {!acc.includes(".") && <em>.ipzmarketing.com</em>}
        </span>
      </label>
      <label className="ig-fld">
        <span>API key</span>
        <span className="ig-fld-in">
          <input type={show ? "text" : "password"} value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste the key" autoComplete="new-password" spellCheck={false} />
          <button type="button" className="ig-fld-eye" onClick={() => setShow((v) => !v)}>{show ? "Hide" : "Show"}</button>
        </span>
      </label>
      <p className="ig-key-note"><Lock />The key is checked with Mailrelay and kept on the server — it never comes back to this page.</p>
      <div className="ig-key-act">
        <button type="submit" className="ig-brand-btn" disabled={!ok || busy}>{busy ? <span className="ig-spin" /> : <Plus />}{busy ? "Checking the key…" : more ? "Add account" : "Connect Mailrelay"}</button>
        {more && <button type="button" className="ig-mini" onClick={() => setOpen(false)}>Cancel</button>}
      </div>
    </form>
  );
}
function MailrelayGuide() {
  return (
    <div className="ig-det-sec ig-guide">
      <h4>Where to find the key · 1 minute</h4>
      <ol>
        <li><b>Open your Mailrelay</b><span>Sign in at your address — the part before <i>.ipzmarketing.com</i> is what goes in <i>Account address</i>.</span></li>
        <li><b>Create a key</b><span><i>Settings → API keys</i> → <i>Add API key</i> → name it “Next”.</span></li>
        <li><b>Paste it here</b><span>Copy the key, paste it above and press <i>Connect Mailrelay</i>. Your groups appear on the account.</span></li>
      </ol>
      <p className="ig-guide-note">Deleting the key in Mailrelay disconnects it at once — <i>Check now</i> will show it needs a new key.</p>
    </div>
  );
}

/* ---------- Google setup guide (shown until VITE_GOOGLE_CLIENT_ID exists) ---------- */
function GoogleGuide() {
  const origin = window.location.origin;
  const [copied, setCopied] = useState("");
  const copy = (t: string) => { void navigator.clipboard?.writeText(t); setCopied(t); setTimeout(() => setCopied(""), 1400); };
  const C = ({ t }: { t: string }) => <button className={`ig-code ${copied === t ? "is-done" : ""}`} onClick={() => copy(t)} title="Copy">{t}{copied === t ? <Check /> : <Copy />}</button>;
  return (
    <div className="ig-det-sec ig-guide">
      <h4>Set up Google sign-in · once, about 10 minutes</h4>
      <ol>
        <li><b>Open Google Cloud Console</b><span>console.cloud.google.com → top bar → <i>New project</i> → name it “Next”.</span></li>
        <li><b>Turn on the two APIs</b><span><i>APIs &amp; Services → Library</i> → search <i>Gmail API</i> → Enable. Same for <i>Google Calendar API</i>.</span></li>
        <li><b>Consent screen</b><span><i>Google Auth Platform → Get started</i>: app name “Next”, your e-mail, audience <i>External</i>. In <i>Audience → Test users</i> add every Gmail you'll connect.</span></li>
        <li><b>Permissions</b><span><i>Data access → Add or remove scopes</i>: tick <i>gmail.readonly</i>, <i>gmail.send</i>, <i>calendar.events</i> (plus openid, email, profile) → Save.</span></li>
        <li><b>Create the client</b><span><i>Clients → Create client</i> → type <i>Web application</i>. Authorised JavaScript origins:</span><C t={origin} /><span>Authorised redirect URIs:</span><C t={`${origin}/settings`} /><span>Add your live address too (e.g. https://your-app.vercel.app and …/settings). Create → copy the <i>Client ID</i> and <i>Client secret</i>.</span></li>
        <li><b>Give the Client ID to the app</b><span>In the project's <i>.env</i> add the line below, then restart <i>npm run dev</i>. In Vercel: <i>Settings → Environment Variables</i> → same name → Redeploy.</span><C t="VITE_GOOGLE_CLIENT_ID=" /></li>
        <li><b>Give both to Supabase</b><span>Supabase → your project → <i>Edge Functions → Secrets</i> → add <i>GOOGLE_CLIENT_ID</i> and <i>GOOGLE_CLIENT_SECRET</i>.</span></li>
        <li><b>Connect</b><span>Reload this page → Gmail → <i>Connect Gmail</i> → pick the account → “Google hasn't verified this app” → <i>Continue</i> → Allow. Done.</span></li>
      </ol>
      <p className="ig-guide-note">While the app is in <i>Testing</i>, Google signs you out every 7 days and only test users can connect. To lift that, publish the app in <i>Audience</i> (Gmail reading needs Google's verification).</p>
    </div>
  );
}

/* ---------- Meta: the pages / Instagram accounts / ad accounts a login reaches ---------- */
function AssetList({ items, none }: { items: ConnectedAsset[]; none?: string }) {
  if (!items.length) return <p className="ig-assets-none">{none ?? "No pages or accounts found for this login yet."}</p>;
  const KIND: Record<ConnectedAsset["kind"], string> = { facebook_page: "Facebook page", instagram: "Instagram", ad_account: "Ad account", linkedin_org: "LinkedIn page", mailrelay_group: "Group", whatsapp_number: "WhatsApp" };
  const order = ["facebook_page", "instagram", "ad_account", "whatsapp_number", "linkedin_org", "mailrelay_group"];
  return (
    <ul className="ig-assets">
      {[...items].sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind)).map((x) => (
        <li key={x.id} className={`is-${x.kind}`}>
          {x.picture_url ? <img src={x.picture_url} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <i>{(x.name || x.username || "?")[0]?.toUpperCase()}</i>}
          <span><b>{x.kind === "instagram" && x.username ? `@${x.username}` : x.kind === "whatsapp_number" ? x.username || x.external_id : x.name || x.external_id}</b><small>{KIND[x.kind]}{x.kind === "linkedin_org" && x.extra?.role ? ` · ${String(x.extra.role).replace(/_/g, " ").toLowerCase()}` : ""}{x.kind === "instagram" && x.extra?.followers != null ? ` · ${Number(x.extra.followers).toLocaleString("en-GB")} followers` : ""}{x.kind === "ad_account" && x.extra?.currency ? ` · ${x.extra.currency}` : ""}{x.kind === "whatsapp_number" ? `${x.name ? ` · ${x.name}` : ""}${x.extra?.quality_rating ? ` · quality ${String(x.extra.quality_rating).toLowerCase()}` : ""}${x.extra?.status && x.extra.status !== "CONNECTED" ? ` · ${String(x.extra.status).toLowerCase()}` : ""}` : ""}{x.kind === "mailrelay_group" && x.extra?.subscribers != null ? ` · ${Number(x.extra.subscribers).toLocaleString("en-GB")} subscribers` : ""}</small></span>
        </li>
      ))}
    </ul>
  );
}

/* ---------- LinkedIn setup guide (shown until VITE_LINKEDIN_CLIENT_ID exists) ---------- */
function LinkedInGuide() {
  const origin = window.location.origin;
  const [copied, setCopied] = useState("");
  const copy = (t: string) => { void navigator.clipboard?.writeText(t); setCopied(t); setTimeout(() => setCopied(""), 1400); };
  const C = ({ t }: { t: string }) => <button className={`ig-code ${copied === t ? "is-done" : ""}`} onClick={() => copy(t)} title="Copy">{t}{copied === t ? <Check /> : <Copy />}</button>;
  return (
    <div className="ig-det-sec ig-guide">
      <h4>Set up LinkedIn sign-in · once, about 10 minutes</h4>
      <ol>
        <li><b>Create the app</b><span>linkedin.com/developers/apps → <i>Create app</i>: name “Next”, your company's <i>LinkedIn Page</i> (you must be its admin), privacy policy URL and logo.</span></li>
        <li><b>Verify it with the page</b><span>In <i>Settings → App settings</i> press <i>Verify</i> and open the link as the page admin.</span></li>
        <li><b>Add the products</b><span><i>Products</i> → request <i>Sign In with LinkedIn using OpenID Connect</i> and <i>Share on LinkedIn</i> (both instant).</span></li>
        <li><b>Redirect URL</b><span><i>Auth → Authorized redirect URLs</i> → add:</span><C t={`${origin}/settings`} /><span>and your live address …/settings.</span></li>
        <li><b>Client ID and secret</b><span>Same <i>Auth</i> tab: copy the <i>Client ID</i> and the <i>Primary Client Secret</i>. In .env and Vercel (type Config):</span><C t="VITE_LINKEDIN_CLIENT_ID=" /></li>
        <li><b>Give them to Supabase</b><span><i>Edge Functions → Secrets</i> → add <i>LINKEDIN_CLIENT_ID</i> and <i>LINKEDIN_CLIENT_SECRET</i>.</span></li>
        <li><b>Company pages (later)</b><span><i>Products</i> → request <i>Community Management API</i> (LinkedIn reviews it; it may ask for a separate app). When approved add <i>VITE_LINKEDIN_PAGES=1</i> — and, if it's a second app, its IDs as <i>VITE_LINKEDIN_PAGES_CLIENT_ID</i> and secrets <i>LINKEDIN_PAGES_CLIENT_ID / _SECRET</i>.</span></li>
      </ol>
      <p className="ig-guide-note">LinkedIn access lasts 60 days; after that the account shows “Needs sign-in” and one click reconnects it.</p>
    </div>
  );
}

/* ---------- Meta setup guide (shown until VITE_META_APP_ID exists) ---------- */
function MetaGuide() {
  const origin = window.location.origin;
  const [copied, setCopied] = useState("");
  const copy = (t: string) => { void navigator.clipboard?.writeText(t); setCopied(t); setTimeout(() => setCopied(""), 1400); };
  const C = ({ t }: { t: string }) => <button className={`ig-code ${copied === t ? "is-done" : ""}`} onClick={() => copy(t)} title="Copy">{t}{copied === t ? <Check /> : <Copy />}</button>;
  return (
    <div className="ig-det-sec ig-guide">
      <h4>Set up Meta sign-in · once, about 15 minutes</h4>
      <ol>
        <li><b>Create the app</b><span>developers.facebook.com → <i>My Apps → Create app</i> → name “Next”. Use cases: <i>Manage everything on your Page</i>, <i>Manage messaging &amp; content on Instagram</i> and <i>Create &amp; manage ads with Marketing API</i>. Link your business portfolio when asked.</span></li>
        <li><b>Add the permissions</b><span>In each use case → <i>Customize</i> → add: pages_show_list, pages_read_engagement, pages_manage_posts, pages_read_user_content, read_insights, instagram_basic, instagram_content_publish, instagram_manage_insights, instagram_manage_comments, ads_read, leads_retrieval, pages_manage_ads, business_management, email.</span></li>
        <li><b>Facebook Login</b><span>Add the product <i>Facebook Login for Business</i> → <i>Settings</i> → Valid OAuth Redirect URIs:</span><C t={`${origin}/settings`} /><span>Add your live address too (…/settings). If it asks for a <i>Configuration</i>, create one (User access token, the permissions above) and keep its ID.</span></li>
        <li><b>App ID and secret</b><span><i>App settings → Basic</i>: copy the <i>App ID</i> and the <i>App secret</i>. Add your domain in <i>App domains</i> and a privacy policy URL.</span></li>
        <li><b>Give them to the app</b><span>In <i>.env</i> and in Vercel (type Config):</span><C t="VITE_META_APP_ID=" /><span>Only if step 3 gave you a Configuration ID:</span><C t="VITE_META_CONFIG_ID=" /></li>
        <li><b>Give them to Supabase</b><span>Supabase → <i>Edge Functions → Secrets</i> → add <i>META_APP_ID</i> and <i>META_APP_SECRET</i>.</span></li>
        <li><b>Testers</b><span>While the app is in Development, only people with a role can connect: <i>App roles → Roles → Add people</i> (Testers).</span></li>
        <li><b>Connect</b><span>Restart <i>npm run dev</i> → Integrations → Meta → <i>Connect Meta</i> → pick the pages and Instagram accounts → Save.</span></li>
      </ol>
      <p className="ig-guide-note">To let any client connect, switch the app to <i>Live</i> and pass Meta's <i>App Review</i> for these permissions (plus Business verification). Instagram needs a business or creator account linked to a Facebook page.</p>
    </div>
  );
}

const Check = () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.2 4.2L19 7" /></svg>;
const X = () => <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>;
const Chev = () => <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>;
const Bell = () => <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0" /></svg>;
const Refresh = () => <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>;
const Copy = () => <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 9h11v11H9zM5 15H4V4h11v1" /></svg>;
const Lock = () => <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>;
const Book = () => <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5zM4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5" /></svg>;
const Send = () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 3 10 14M21 3l-7 18-4-7-7-4z" /></svg>;
const Plus = () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>;
