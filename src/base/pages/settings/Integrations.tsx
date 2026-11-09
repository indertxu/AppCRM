/* =====================================================================
   BASE · Settings → Integrations
   Two columns:
     left  — Connected: every account you linked (two Gmails, two Outlooks…),
             one sleek row each, remove with a confirm
     right — Add an app: what you can connect now, and what's coming
   Connecting one flies its logo from the right list into the left one.
   Nothing here decides what an account is used for: Billing and the other
   pages pick from the connected accounts later.
     Gmail, Google Calendar → connected_accounts (SQL 119) via the edge function
                              "connected-accounts" (src/base/api/connectedAccounts.ts)
     Outlook                → the first account is the existing Outlook connection
                              (outlook-sync: calendar + mail); more go to connected_accounts
   Prefix .ig-
   ===================================================================== */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { outlookMailStatus } from "../../api/outlookSync";
import { addAccount, listAccounts, providerReady, removeAccount, type ConnectedAccount, type Provider, type Service } from "../../api/connectedAccounts";
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
type AppDef = { k: string; name: string; what: string; logo: { k?: string; color: string; letters?: string }; live?: { provider: Provider; service: Service }; brings?: string[] };
const LIVE: AppDef[] = [
  { k: "gmail", name: "Gmail", what: "Send and read mail from your Google inboxes", logo: { k: "gmail", color: "#ea4335" }, live: { provider: "google", service: "mail" } },
  { k: "gcal", name: "Google Calendar", what: "Your meetings and activities, both ways", logo: { k: "gcal", color: "#4285f4" }, live: { provider: "google", service: "calendar" } },
  { k: "outlook", name: "Outlook", what: "Mail and calendars from Microsoft 365", logo: { k: "outlook", color: "#0078d4" }, live: { provider: "microsoft", service: "mail" } },
];
const SOON: AppDef[] = [
  { k: "whatsapp", name: "WhatsApp Business", what: "Chat with clients, kept on each client", logo: { k: "whatsapp", color: "#25d366" } },
  { k: "meta", name: "Meta", what: "Facebook and Instagram pages, Meta Ads", logo: { k: "meta", color: "#0467df" } },
  { k: "instagram", name: "Instagram", what: "Posts, reels and their results", logo: { k: "instagram", color: "#ff0069" } },
  { k: "messenger", name: "Messenger", what: "Facebook and Instagram DMs in one inbox", logo: { k: "messenger", color: "#0866ff" } },
  { k: "linkedin", name: "LinkedIn", what: "Company page, LinkedIn Ads, lead forms", logo: { k: "linkedin", color: "#0a66c2" } },
  { k: "tiktok", name: "TikTok", what: "Short videos and TikTok Ads", logo: { k: "tiktok", color: "#000" } },
  { k: "gads", name: "Google Ads", what: "Search and display campaigns", logo: { k: "gads", color: "#4285f4" } },
  { k: "youtube", name: "YouTube", what: "Videos, views and subscribers", logo: { k: "youtube", color: "#ff0000" } },
  { k: "x", name: "X", what: "Posts and engagement", logo: { k: "x", color: "#000" } },
  { k: "ga", name: "Google Analytics", what: "Website visitors and sources", logo: { k: "ga", color: "#e37400" } },
  { k: "gbp", name: "Google Business Profile", what: "Reviews and your Maps listing", logo: { k: "google", color: "#4285f4" } },
  { k: "web", name: "Your website", what: "Site forms become leads in Orbit", logo: { color: "#0f9f6e", letters: "</>" } },
];
const APP = Object.fromEntries([...LIVE, ...SOON].map((a) => [a.k, a])) as Record<string, AppDef>;
const WANT_KEY = "next.base.integrations.want";
const SVC: Record<Service, string> = { mail: "Mail", calendar: "Calendar" };

type Row = { key: string; app: string; id: string; email: string; services: Service[]; status: "active" | "error"; note?: string | null; primary?: boolean };

export default function Integrations({ onBack, outlook }: { onBack: () => void; outlook: OutlookProps }) {
  const [want, setWant] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(WANT_KEY) || "[]"); } catch { return []; } });
  useEffect(() => { try { localStorage.setItem(WANT_KEY, JSON.stringify(want)); } catch { /* ignore */ } }, [want]);
  const [q, setQ] = useState("");

  const [accounts, setAccounts] = useState<ConnectedAccount[] | null>(null);
  const [outlookEmail, setOutlookEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<{ k: string; text: string } | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(""), 2600); return () => clearTimeout(t); }, [toast]);

  const reload = useCallback(async () => { const r = await listAccounts(); setAccounts(r.accounts); }, []);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    if (!outlook.connected) { setOutlookEmail(null); return; }
    outlookMailStatus().then((m) => setOutlookEmail(m.email)).catch(() => setOutlookEmail(null));
  }, [outlook.connected]);

  /* the left list: one row per account and app */
  const rows: Row[] = [];
  if (outlook.connected) rows.push({ key: "outlook:primary", app: "outlook", id: "outlook-primary", email: outlookEmail ?? "Outlook account", services: ["mail", "calendar"], status: "active", primary: true });
  for (const a of accounts ?? []) {
    if (a.provider === "microsoft") { if (a.email !== outlookEmail) rows.push({ key: `outlook:${a.id}`, app: "outlook", id: a.id, email: a.email, services: a.services, status: a.status, note: a.last_error }); continue; }
    for (const s of a.services) rows.push({ key: `${s === "mail" ? "gmail" : "gcal"}:${a.id}`, app: s === "mail" ? "gmail" : "gcal", id: a.id, email: a.email, services: [s], status: a.status, note: a.last_error });
  }
  const countOf = (k: string) => rows.filter((r) => r.app === k).length;

  /* ---- the logo that flies from the right list into the left one ---- */
  const fly = useRef<{ app: string; rect: DOMRect } | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<string[]>([]);
  const listRef = useRef<HTMLUListElement>(null);
  const rowKeys = rows.map((r) => r.key).join("|");
  useLayoutEffect(() => {
    const now = new Set(rows.map((r) => r.key));
    if (seen.current === null) { if (accounts !== null && outlook.connected !== null) seen.current = now; return; }
    const added = rows.filter((r) => !seen.current!.has(r.key));
    seen.current = now;
    if (!added.length) return;
    setFresh(added.map((r) => r.key));
    window.setTimeout(() => setFresh([]), 1400);
    const f = fly.current; fly.current = null;
    const target = f && added.find((r) => r.app === f.app);
    const dest = target && listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(target.key)}"] .ig-logo`);
    if (!f || !dest || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const to = dest.getBoundingClientRect();
    const ghost = dest.cloneNode(true) as HTMLElement;
    Object.assign(ghost.style, { position: "fixed", left: `${f.rect.left}px`, top: `${f.rect.top}px`, width: `${f.rect.width}px`, height: `${f.rect.height}px`, margin: "0", zIndex: "400", pointerEvents: "none" });
    document.body.appendChild(ghost);
    dest.style.opacity = "0";
    const dx = to.left - f.rect.left, dy = to.top - f.rect.top, sc = to.width / f.rect.width;
    const anim = ghost.animate([
      { transform: "translate(0,0) scale(1)", offset: 0 },
      { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 60}px) scale(${1 + (sc - 1) * 0.5 + 0.18})`, offset: 0.5 },
      { transform: `translate(${dx}px, ${dy}px) scale(${sc})`, offset: 1 },
    ], { duration: 720, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
    anim.onfinish = () => { ghost.remove(); dest.style.opacity = ""; dest.animate([{ transform: "scale(1.25)" }, { transform: "scale(1)" }], { duration: 380, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" }); };
  }, [rowKeys, accounts === null, outlook.connected === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = async (a: AppDef, from: HTMLElement | null) => {
    setErr(null);
    const logo = from?.closest(".ig-app")?.querySelector<HTMLElement>(".ig-logo");
    if (logo) fly.current = { app: a.k, rect: logo.getBoundingClientRect() };
    if (a.k === "outlook" && !outlook.connected) { outlook.onConnect(); return; }
    if (!a.live) return;
    setBusy(a.k);
    const r = await addAccount(a.live.provider, a.live.provider === "microsoft" ? ["mail", "calendar"] : [a.live.service]);
    setBusy(null);
    if (r.error) { fly.current = null; setErr({ k: a.k, text: r.error }); return; }
    await reload();
    setToast(`${r.account?.email ?? "Account"} connected`);
  };
  const remove = async (r: Row) => {
    setAsking(null);
    if (r.primary) { outlook.onDisconnect(); return; }
    const e = await removeAccount(r.id);
    if (e) { setErr({ k: r.app, text: e }); return; }
    await reload();
    setToast(`${r.email} removed`);
  };

  const needle = q.trim().toLowerCase();
  const match = (a: AppDef) => !needle || `${a.name} ${a.what}`.toLowerCase().includes(needle);
  const live = LIVE.filter(match), soon = SOON.filter(match);
  const loading = accounts === null || outlook.connected === null;

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

      <div className="ig-body">
        {/* ---------- connected ---------- */}
        <section className="ig-sec">
          <div className="ig-sec-h">
            <h2>Connected</h2><span className="ig-n">{rows.length}</span>
            <p>Billing, Calendar and Growth pick from these accounts.</p>
          </div>
          {loading ? <div className="ig-conn"><i className="ig-skel" /><i className="ig-skel" /></div> : (
            <ul className="ig-conn" ref={listRef}>
              {rows.map((r) => {
                const a = APP[r.app];
                const c = BRANDS[a.logo.k ?? ""]?.hex ?? a.logo.color;
                return (
                  <li key={r.key} data-key={r.key} className={`ig-cc ${fresh.includes(r.key) ? "is-fresh" : ""} ${r.status === "error" ? "is-err" : ""}`} style={{ ["--c" as string]: c }}>
                    <div className="ig-cc-top">
                      <Logo {...a.logo} s={38} />
                      <span className="ig-cc-app">{a.name}</span>
                      <span className={`ig-dot ${r.status === "error" ? "is-err" : ""}`} title={r.status === "error" ? "Needs attention" : "Working"} />
                    </div>
                    <b className="ig-cc-mail" title={r.email}>{r.email}</b>
                    <div className="ig-cc-foot">
                      {r.status === "error" ? <em className="ig-cc-err">{r.note || "Sign in again"}</em>
                        : r.services.map((s) => <span key={s} className="ig-chip">{SVC[s]}</span>)}
                      {asking === r.key ? (
                        <span className="ig-ask">
                          <button className="is-yes" onClick={() => void remove(r)}>Remove</button>
                          <button onClick={() => setAsking(null)}>Keep</button>
                        </span>
                      ) : (
                        <button className="ig-rm" onClick={() => setAsking(r.key)} aria-label={`Remove ${r.email}`} title="Remove">
                          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
              {rows.length === 0 && (
                <li className="ig-cc is-empty">
                  <span className="ig-empty-art" aria-hidden="true"><i /><i /><i /></span>
                  <b>Nothing connected yet</b>
                  <span>Connect an app below — it shows up here.</span>
                </li>
              )}
            </ul>
          )}
        </section>

        {/* ---------- available now ---------- */}
        {live.length > 0 && (
          <section className="ig-sec">
            <div className="ig-sec-h"><h2>Available</h2><p>Connect one account or several.</p></div>
            <div className="ig-feats">
              {live.map((a, i) => {
                const ready = a.k === "outlook" || providerReady(a.live!.provider);
                const n = countOf(a.k);
                const isBusy = busy === a.k || (a.k === "outlook" && outlook.busy);
                const error = err?.k === a.k ? err.text : a.k === "outlook" && !outlook.connected ? outlook.error : null;
                const c = BRANDS[a.logo.k ?? ""]?.hex ?? a.logo.color;
                return (
                  <article key={a.k} className="ig-feat ig-app" style={{ ["--c" as string]: c, ["--i" as string]: i }}>
                    <div className="ig-feat-top">
                      <Logo {...a.logo} s={48} />
                      {n > 0 && <span className="ig-has"><span className="ig-dot" />{n} connected</span>}
                    </div>
                    <h3>{a.name}</h3>
                    <p className={error ? "is-err" : ""}>{error || (ready ? a.what : "Google sign-in has to be switched on first (Client ID).")}</p>
                    <button className={`ig-brand-btn ${n ? "is-soft" : ""}`} disabled={!ready || isBusy || loading} onClick={(e) => void connect(a, e.currentTarget)}>
                      {isBusy ? <span className="ig-spin" /> : <Plus />}{isBusy ? "Waiting for sign-in…" : n ? "Add another account" : `Connect ${a.name}`}
                    </button>
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {/* ---------- coming soon ---------- */}
        {soon.length > 0 && (
          <section className="ig-sec">
            <div className="ig-sec-h"><h2>Coming soon</h2><p>Tap the ones you want first — we build them in that order.</p></div>
            <div className="ig-soon">
              {soon.map((a, i) => {
                const on = want.includes(a.k);
                return (
                  <button key={a.k} className={`ig-st ${on ? "is-on" : ""}`} style={{ ["--i" as string]: i }} title={a.what}
                    onClick={() => setWant((w) => (w.includes(a.k) ? w.filter((x) => x !== a.k) : [...w, a.k]))}>
                    <Logo {...a.logo} s={34} />
                    <span className="ig-st-txt"><b>{a.name}</b><small>{on ? "Requested" : a.what}</small></span>
                    <span className="ig-bell" aria-hidden="true">{on ? <Check /> : <Bell />}</span>
                  </button>
                );
              })}
            </div>
          </section>
        )}
        {!live.length && !soon.length && <p className="ig-none">No app matches “{q}”.</p>}
      </div>

      {toast && <div className="ig-toast"><Check />{toast}</div>}
    </div>
  );
}

const Check = () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.2 4.2L19 7" /></svg>;
const Bell = () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0" /></svg>;
const Plus = () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>;
