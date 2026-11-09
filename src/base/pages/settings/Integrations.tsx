/* =====================================================================
   BASE · Settings → Integrations
   Connect the apps you work with — several accounts each (two Gmails, two
   Outlooks…). Nothing here decides what an account is used for: Billing and
   the other pages pick from the connected accounts later.
     Gmail, Google Calendar  → connected_accounts (SQL 119) via the edge function
                               "connected-accounts" (src/base/api/connectedAccounts.ts)
     Outlook                 → the first account is the existing Outlook connection
                               (outlook-sync: calendar sync + mail); more accounts
                               go to connected_accounts like Google's
   The rest are on the way: "Notify me" remembers which ones you want.
   Prefix .ig-
   ===================================================================== */
import { useCallback, useEffect, useState, type ReactNode } from "react";
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
function Logo({ k, color, letters }: { k?: string; color: string; letters?: string }) {
  const b = k ? BRANDS[k] : undefined;
  return (
    <span className="ig-logo" style={{ ["--c" as string]: b?.hex ?? color }}>
      {b ? <svg viewBox="0 0 24 24" width="22" height="22" aria-label={b.title} role="img"><path d={b.path} fill="currentColor" /></svg>
        : <span className="ig-logo-t">{letters}</span>}
    </span>
  );
}

/* ---------- apps that aren't connectable yet ---------- */
type Group = "chat" | "social" | "data";
type Soon = { k: string; name: string; what: string; logo: ReactNode; group: Group; brings?: string[] };
const SOON: Soon[] = [
  { k: "whatsapp", name: "WhatsApp Business", what: "Chat with clients from the app, kept with each client.", logo: <Logo k="whatsapp" color="#25d366" />, group: "chat",
    brings: ["One or more business numbers", "Messages saved on the client", "Follow-ups by WhatsApp"] },
  { k: "messenger", name: "Messenger & Instagram DMs", what: "Answer DMs from Facebook and Instagram in one inbox.", logo: <Logo k="messenger" color="#0866ff" />, group: "chat" },
  { k: "meta", name: "Meta", what: "Facebook and Instagram pages and Meta Ads: post, advertise, read the results.", logo: <Logo k="meta" color="#0467df" />, group: "social",
    brings: ["Several Facebook and Instagram pages", "Meta Ads accounts", "Leads from Meta forms into Orbit"] },
  { k: "instagram", name: "Instagram", what: "Publish posts and reels and read reach, likes and comments.", logo: <Logo k="instagram" color="#ff0069" />, group: "social" },
  { k: "linkedin", name: "LinkedIn", what: "Company page posts, LinkedIn Ads and lead-gen forms.", logo: <Logo color="#0a66c2" letters="in" />, group: "social" },
  { k: "tiktok", name: "TikTok", what: "Publish short videos and run TikTok Ads.", logo: <Logo k="tiktok" color="#000" />, group: "social" },
  { k: "gads", name: "Google Ads", what: "Search and display campaigns, with cost per lead.", logo: <Logo k="gads" color="#4285f4" />, group: "social" },
  { k: "youtube", name: "YouTube", what: "Upload videos and read views and subscribers.", logo: <Logo k="youtube" color="#ff0000" />, group: "social" },
  { k: "x", name: "X", what: "Publish posts and read engagement.", logo: <Logo k="x" color="#000" />, group: "social" },
  { k: "ga", name: "Google Analytics", what: "Visitors, sources and conversions of your website.", logo: <Logo k="ga" color="#e37400" />, group: "data" },
  { k: "gbp", name: "Google Business Profile", what: "Reviews and your listing on Google Maps.", logo: <Logo k="google" color="#4285f4" />, group: "data" },
  { k: "web", name: "Your website", what: "Forms on your site create the company, contact and deal in Orbit.", logo: <Logo color="#0f9f6e" letters="</>" />, group: "data" },
];
const GROUPS: { k: "mail" | Group; title: string; sub: string }[] = [
  { k: "mail", title: "Mail & calendar", sub: "Several accounts per app — pick which one to use later, page by page" },
  { k: "chat", title: "Messaging", sub: "Conversations with clients" },
  { k: "social", title: "Social & ads", sub: "Publish, advertise and read the results" },
  { k: "data", title: "Website & analytics", sub: "Where your visitors and leads come from" },
];
const WANT_KEY = "next.base.integrations.want";

/* ---------- connectable apps ---------- */
type Live = { k: string; name: string; what: string; logo: ReactNode; provider: Provider; service: Service };
const LIVE: Live[] = [
  { k: "gmail", name: "Gmail", what: "Inboxes", logo: <Logo k="gmail" color="#ea4335" />, provider: "google", service: "mail" },
  { k: "gcal", name: "Google Calendar", what: "Calendars", logo: <Logo k="gcal" color="#4285f4" />, provider: "google", service: "calendar" },
  { k: "outlook", name: "Microsoft Outlook", what: "Mail and calendars", logo: <Logo color="#0a64d6" letters="O" />, provider: "microsoft", service: "mail" },
];

type Row = { id: string; email: string; services: Service[]; status: "active" | "error"; note?: string | null; primary?: boolean };

export default function Integrations({ onBack, outlook }: { onBack: () => void; outlook: OutlookProps }) {
  const [want, setWant] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(WANT_KEY) || "[]"); } catch { return []; } });
  useEffect(() => { try { localStorage.setItem(WANT_KEY, JSON.stringify(want)); } catch { /* ignore */ } }, [want]);
  const toggleWant = (k: string) => setWant((w) => (w.includes(k) ? w.filter((x) => x !== k) : [...w, k]));
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Soon | null>(null);

  const [accounts, setAccounts] = useState<ConnectedAccount[] | null>(null);
  const [needsSql, setNeedsSql] = useState(false);
  const [outlookEmail, setOutlookEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);       // app key while adding
  const [err, setErr] = useState<Record<string, string>>({});
  const [toast, setToast] = useState("");
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(""), 2600); return () => clearTimeout(t); }, [toast]);

  const reload = useCallback(async () => {
    const r = await listAccounts();
    setAccounts(r.accounts); setNeedsSql(r.needsSql);
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    if (!outlook.connected) { setOutlookEmail(null); return; }
    outlookMailStatus().then((m) => setOutlookEmail(m.email)).catch(() => setOutlookEmail(null));
  }, [outlook.connected]);

  const rowsFor = (a: Live): Row[] => {
    const extra = (accounts ?? []).filter((x) => x.provider === a.provider && (a.provider === "microsoft" || x.services.includes(a.service)))
      .map((x) => ({ id: x.id, email: x.email, services: x.services, status: x.status, note: x.last_error }));
    if (a.k !== "outlook" || !outlook.connected) return extra;
    const first: Row = { id: "outlook-primary", email: outlookEmail ?? "Outlook account", services: ["calendar", "mail"], status: "active", primary: true };
    return [first, ...extra.filter((x) => x.email !== outlookEmail)];
  };

  const add = async (a: Live) => {
    setErr((e) => ({ ...e, [a.k]: "" }));
    if (a.k === "outlook" && !outlook.connected) { outlook.onConnect(); return; }
    setBusy(a.k);
    const services: Service[] = a.provider === "microsoft" ? ["mail", "calendar"] : [a.service];
    const r = await addAccount(a.provider, services);
    setBusy(null);
    if (r.error) { setErr((e) => ({ ...e, [a.k]: r.error! })); return; }
    await reload();
    setToast(`${r.account?.email ?? "Account"} connected`);
  };
  const remove = async (a: Live, row: Row) => {
    if (row.primary) { outlook.onDisconnect(); return; }
    const e = await removeAccount(row.id);
    if (e) { setErr((x) => ({ ...x, [a.k]: e })); return; }
    await reload();
    setToast(`${row.email} removed`);
  };

  const needle = q.trim().toLowerCase();
  const match = (s: string) => !needle || s.toLowerCase().includes(needle);
  const connectedCount = (accounts?.length ?? 0) + (outlook.connected ? 1 : 0);
  const anything = LIVE.some((a) => match(`${a.name} ${a.what} mail calendar`)) || SOON.some((a) => match(`${a.name} ${a.what}`));

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
        <span className="ig-count"><b>{connectedCount}</b> account{connectedCount === 1 ? "" : "s"} connected</span>
        <label className="ig-search">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an app" />
        </label>
      </header>

      {GROUPS.map((g, gi) => {
        if (g.k === "mail") {
          const apps = LIVE.filter((a) => match(`${a.name} ${a.what} mail calendar`));
          if (!apps.length) return null;
          return (
            <section key={g.k} className="ig-group" style={{ ["--gi" as string]: gi }}>
              <div className="ig-group-h"><h2>{g.title}</h2><p>{g.sub}</p></div>
              {needsSql && <p className="ig-note">Connecting more accounts needs one database step (SQL 119) — it's on its way.</p>}
              <div className="ig-grid is-live">
                {apps.map((a, i) => {
                  const rows = rowsFor(a);
                  const ready = a.k === "outlook" ? true : providerReady(a.provider);
                  return (
                    <AccountCard key={a.k} app={a} i={i} rows={rows} ready={ready} loading={accounts === null || (a.k === "outlook" && outlook.connected === null)}
                      busy={busy === a.k || (a.k === "outlook" && outlook.busy)} error={err[a.k] || (a.k === "outlook" && !outlook.connected ? outlook.error : null) || ""}
                      onAdd={() => void add(a)} onRemove={(r) => void remove(a, r)} />
                  );
                })}
              </div>
            </section>
          );
        }
        const apps = SOON.filter((a) => a.group === g.k && match(`${a.name} ${a.what}`));
        if (!apps.length) return null;
        return (
          <section key={g.k} className="ig-group" style={{ ["--gi" as string]: gi }}>
            <div className="ig-group-h"><h2>{g.title}</h2><p>{g.sub}</p></div>
            <div className="ig-grid">
              {apps.map((a, i) => (
                <article key={a.k} className="ig-card" style={{ ["--i" as string]: i }}>
                  <div className="ig-card-top">{a.logo}<span className="ig-tag is-soon">Soon</span></div>
                  <b>{a.name}</b>
                  <p>{a.what}</p>
                  <div className="ig-card-foot">
                    {a.brings && <button className="ig-more" onClick={() => setOpen(a)}>What it brings</button>}
                    <button className={`ig-btn ${want.includes(a.k) ? "is-on" : "is-ghost"}`} onClick={() => toggleWant(a.k)}>
                      {want.includes(a.k) ? <><Check />Requested</> : "Notify me"}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        );
      })}
      {!anything && <p className="ig-none">No app matches “{q}”.</p>}

      {open && (
        <div className="ig-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(null); }}>
          <div className="ig-modal">
            <header>{open.logo}<div><h3>{open.name}</h3><p>{open.what}</p></div>
              <button className="ig-x" onClick={() => setOpen(null)} aria-label="Close">×</button></header>
            <ul>{open.brings?.map((b) => <li key={b}><Check />{b}</li>)}</ul>
            <footer>
              <span>Not available yet. Ask for it and we'll build it in that order.</span>
              <button className={`ig-btn ${want.includes(open.k) ? "is-on" : ""}`} onClick={() => toggleWant(open.k)}>{want.includes(open.k) ? <><Check />Requested</> : "Notify me"}</button>
            </footer>
          </div>
        </div>
      )}
      {toast && <div className="ig-toast"><Check />{toast}</div>}
    </div>
  );
}

const Check = () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.2 4.2L19 7" /></svg>;
const SVC: Record<Service, string> = { mail: "Mail", calendar: "Calendar" };

function AccountCard({ app, i, rows, ready, loading, busy, error, onAdd, onRemove }: {
  app: Live; i: number; rows: Row[]; ready: boolean; loading: boolean; busy: boolean; error: string;
  onAdd: () => void; onRemove: (r: Row) => void;
}) {
  const [asking, setAsking] = useState<string | null>(null);
  const n = rows.length;
  return (
    <article className={`ig-card is-acc ${n ? "is-live" : ""}`} style={{ ["--i" as string]: i }}>
      <div className="ig-card-top">
        {app.logo}
        <div className="ig-card-name"><b>{app.name}</b><p>{app.what}</p></div>
        <span className={`ig-tag ${n ? "is-live" : !ready ? "is-setup" : ""}`}>{loading ? "…" : n ? `${n} account${n === 1 ? "" : "s"}` : ready ? "Not connected" : "Needs setup"}</span>
      </div>
      {n > 0 && (
        <ul className="ig-accs">
          {rows.map((r) => (
            <li key={r.id} className={r.status === "error" ? "is-err" : ""}>
              <i className="ig-av">{r.email[0]?.toUpperCase() ?? "?"}</i>
              <div>
                <b title={r.email}>{r.email}</b>
                <span>{r.status === "error" ? (r.note || "Sign in again to keep it working") : r.services.map((s) => SVC[s]).join(" · ")}</span>
              </div>
              {asking === r.id ? (
                <span className="ig-ask">
                  <button className="is-yes" onClick={() => { setAsking(null); onRemove(r); }}>Remove</button>
                  <button onClick={() => setAsking(null)}>Keep</button>
                </span>
              ) : (
                <button className="ig-rm" onClick={() => setAsking(r.id)} aria-label={`Remove ${r.email}`} title="Remove">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="ig-err">{error}</p>}
      {!ready && !n && <p className="ig-hint">Google sign-in still has to be switched on for this app.</p>}
      <div className="ig-card-foot">
        <button className={`ig-btn ${n ? "is-ghost" : ""}`} onClick={onAdd} disabled={busy || loading || !ready}>
          {busy ? "Waiting for sign-in…" : n ? <><Plus />Add another account</> : <><Plus />Connect</>}
        </button>
      </div>
    </article>
  );
}
const Plus = () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>;
