/* =====================================================================
   BASE · Settings → Integrations
   Every outside app in one place: mail & calendar, messaging, social & ads,
   analytics. Outlook is live (calendar sync + the mailbox Billing sends
   invoices from); the rest are on the way — "Notify me" remembers which ones
   you want (per browser) so they can be built in that order.
   Prefix .ig-
   ===================================================================== */
import { useEffect, useState, type ReactNode } from "react";
import "./Integrations.css";

export type OutlookProps = {
  connected: boolean | null; busy: boolean; error: string | null; onToggle: () => void;
  mailOn: boolean | null; mailBusy: boolean; onMail: () => void;
};

type App = {
  k: string; name: string; what: string; color: string; logo: ReactNode; group: Group;
  brings?: string[];
};
type Group = "mail" | "chat" | "social" | "data";
const GROUPS: { k: Group; title: string; sub: string }[] = [
  { k: "mail", title: "Mail & calendar", sub: "Your mailbox and agenda, linked to clients, deals and invoices" },
  { k: "chat", title: "Messaging", sub: "Conversations with clients, kept with each client" },
  { k: "social", title: "Social & ads", sub: "Publish, advertise and read the results from Growth" },
  { k: "data", title: "Website & analytics", sub: "Where your visitors and leads come from" },
];

const T = (s: string, size = 13) => <span style={{ fontSize: size, fontWeight: 800, letterSpacing: "-0.02em" }}>{s}</span>;
const APPS: App[] = [
  { k: "gmail", name: "Gmail", what: "Send invoices and proposals from your Gmail; see client e-mails in their file.", color: "#ea4335", logo: T("M", 16), group: "mail",
    brings: ["Your Google mailbox as sender", "Client e-mails in the client file", "Google Calendar sync"] },
  { k: "gcal", name: "Google Calendar", what: "Activities you book here appear in your Google Calendar.", color: "#4285f4", logo: T("31"), group: "mail" },
  { k: "whatsapp", name: "WhatsApp Business", what: "Chat with clients from the app; conversations are summarised in Customers.", color: "#25d366", logo: T("WA"), group: "chat",
    brings: ["One shared business number", "Messages saved on the client", "Follow-ups by WhatsApp"] },
  { k: "messenger", name: "Messenger & Instagram DMs", what: "Answer DMs from Facebook and Instagram in one inbox.", color: "#a033ff", logo: T("DM"), group: "chat" },
  { k: "meta", name: "Meta", what: "Facebook, Instagram and Meta Ads: post, advertise and read reach, likes and comments.", color: "#1877f2", logo: T("∞", 18), group: "social",
    brings: ["Facebook and Instagram pages", "Meta Ads accounts, paid from the Growth wallet", "Leads from Meta forms into Orbit"] },
  { k: "linkedin", name: "LinkedIn", what: "Company page posts, LinkedIn Ads and lead-gen forms.", color: "#0a66c2", logo: T("in", 15), group: "social" },
  { k: "tiktok", name: "TikTok", what: "Publish short videos and run TikTok Ads.", color: "#111", logo: T("TT"), group: "social" },
  { k: "gads", name: "Google Ads", what: "Search and display campaigns, with cost per lead in Growth.", color: "#fbbc04", logo: T("Ads", 11), group: "social" },
  { k: "youtube", name: "YouTube", what: "Upload videos and read views and subscribers.", color: "#ff0000", logo: T("▶", 14), group: "social" },
  { k: "x", name: "X (Twitter)", what: "Publish posts and read engagement.", color: "#0f1419", logo: T("X", 15), group: "social" },
  { k: "ga", name: "Google Analytics", what: "Visitors, sources and conversions of your website.", color: "#e37400", logo: T("GA"), group: "data" },
  { k: "gbp", name: "Google Business Profile", what: "Reviews and your listing on Google Maps.", color: "#34a853", logo: T("G", 15), group: "data" },
  { k: "web", name: "Your website", what: "Forms on your site create the company, contact and deal in Orbit.", color: "#0f9f6e", logo: T("</>", 11), group: "data" },
];
const WANT_KEY = "next.base.integrations.want";

export default function Integrations({ onBack, outlook }: { onBack: () => void; outlook: OutlookProps }) {
  const [want, setWant] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(WANT_KEY) || "[]"); } catch { return []; } });
  useEffect(() => { try { localStorage.setItem(WANT_KEY, JSON.stringify(want)); } catch { /* ignore */ } }, [want]);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<App | null>(null);
  const live = (outlook.connected ? 1 : 0);
  const needle = q.trim().toLowerCase();
  const match = (s: string) => !needle || s.toLowerCase().includes(needle);
  const toggleWant = (k: string) => setWant((w) => (w.includes(k) ? w.filter((x) => x !== k) : [...w, k]));

  return (
    <div className="ig">
      <header className="ig-head">
        <button className="ig-back" onClick={onBack} aria-label="Back to Settings">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
        </button>
        <div className="ig-head-txt">
          <h1>Integrations</h1>
          <p>Every app you work with, connected in one place</p>
        </div>
        <span className="ig-count"><b>{live}</b> connected<i>·</i><b>{want.length}</b> requested</span>
        <label className="ig-search">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an app" />
        </label>
      </header>

      {GROUPS.map((g, gi) => {
        const apps = APPS.filter((a) => a.group === g.k && match(`${a.name} ${a.what}`));
        const showOutlook = g.k === "mail" && match("outlook microsoft calendar mail invoices");
        if (!apps.length && !showOutlook) return null;
        return (
          <section key={g.k} className="ig-group" style={{ ["--gi" as string]: gi }}>
            <div className="ig-group-h"><h2>{g.title}</h2><p>{g.sub}</p></div>
            <div className="ig-grid">
              {showOutlook && <OutlookCard o={outlook} />}
              {apps.map((a, i) => (
                <article key={a.k} className="ig-card" style={{ ["--c" as string]: a.color, ["--i" as string]: i }}>
                  <div className="ig-card-top">
                    <span className="ig-logo">{a.logo}</span>
                    <span className="ig-tag is-soon">Soon</span>
                  </div>
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
      {needle && !APPS.some((a) => match(`${a.name} ${a.what}`)) && !match("outlook microsoft calendar mail invoices") && <p className="ig-none">No app matches “{q}”.</p>}

      {open && (
        <div className="ig-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(null); }}>
          <div className="ig-modal" style={{ ["--c" as string]: open.color }}>
            <header><span className="ig-logo">{open.logo}</span><div><h3>{open.name}</h3><p>{open.what}</p></div>
              <button className="ig-x" onClick={() => setOpen(null)} aria-label="Close">×</button></header>
            <ul>{open.brings?.map((b) => <li key={b}><Check />{b}</li>)}</ul>
            <footer>
              <span>Not available yet. Ask for it and we'll build it in that order.</span>
              <button className={`ig-btn ${want.includes(open.k) ? "is-on" : ""}`} onClick={() => toggleWant(open.k)}>{want.includes(open.k) ? <><Check />Requested</> : "Notify me"}</button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

const Check = () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.2 4.2L19 7" /></svg>;

/** Outlook — the one that works today: calendar sync + the mailbox invoices go out from. */
function OutlookCard({ o }: { o: OutlookProps }) {
  return (
    <article className={`ig-card is-wide ${o.connected ? "is-live" : ""}`} style={{ ["--c" as string]: "#0a64d6" }}>
      <div className="ig-card-top">
        <span className="ig-logo"><span style={{ fontSize: 15, fontWeight: 800 }}>O</span></span>
        <div className="ig-card-name"><b>Microsoft Outlook</b><p>Calendar and mailbox</p></div>
        <span className={`ig-tag ${o.connected ? "is-live" : ""}`}>{o.connected === null ? "…" : o.connected ? "Connected" : "Not connected"}</span>
      </div>
      <div className="ig-rows">
        <div className="ig-row">
          <div><b>Calendar sync</b><span>{o.connected ? "New and edited activities appear in your Outlook calendar." : "Activities you book here also land in your Outlook calendar."}</span></div>
          <button className={`ig-btn ${o.connected ? "is-danger" : ""}`} onClick={o.onToggle} disabled={o.busy || o.connected === null}>
            {o.connected === null ? "…" : o.busy && !o.connected ? "Waiting for Microsoft…" : o.connected ? "Disconnect" : "Connect"}
          </button>
        </div>
        <div className="ig-row">
          <div><b>Mailbox for invoices</b><span>{o.mailOn ? "Billing sends invoices from your own address." : "Billing can send invoices from your own address. It only asks to read and send mail."}</span></div>
          <button className={`ig-btn ${o.mailOn ? "is-on" : ""}`} onClick={o.onMail} disabled={o.mailBusy || o.mailOn === null || !!o.mailOn}>
            {o.mailOn === null ? "…" : o.mailBusy ? "Waiting for Microsoft…" : o.mailOn ? <><Check />Linked</> : "Link mailbox"}
          </button>
        </div>
      </div>
      {!o.connected && o.error && <p className="ig-err">Couldn't connect: {o.error}</p>}
    </article>
  );
}
