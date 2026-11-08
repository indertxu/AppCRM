/* =====================================================================
   BASE · Growth — Marketing and Customer health on ONE page.
   A MOCK for now (sample data: nothing is sent, paid or published).

   Two halves, one tab bar:
     Overview                     — the few numbers that matter + what needs you
     Attract  · Campaigns         — AI-made campaigns on every channel, with results
              · Ads               — pay Meta / Google / LinkedIn / TikTok from here
              · Website           — generate the company site (leads go to Orbit)
     Keep     · Customers         — health of every client + AI summary of what
                                    was said (mails, WhatsApp)
              · Follow-ups        — automatic sequences; a reply from anyone at
                                    the client counts as "the client replied"

   Design rules (Base = simple): white surfaces, one accent, one action per
   block, details open in a side panel instead of crowding the page.
   Prefix .gr-
   ===================================================================== */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import "./GrowthPage.css";

/* ---------------- icons ---------------- */
const P = {
  spark: "M12 3l1.8 4.9L19 9.7l-5.2 1.8L12 16.4l-1.8-4.9L5 9.7l5.2-1.8z",
  plus: "M12 5v14M5 12h14", x: "M6 6l12 12M18 6L6 18", check: "M5 12.5l4.2 4.2L19 7",
  chev: "M9 6l6 6-6 6", down: "M6 9l6 6 6-6", back: "M15 6l-6 6 6 6",
  mail: "M4 6h16v12H4zM4 7l8 6 8-6", chat: "M4 5h16v11H9l-5 4z", phone: "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z",
  heart: "M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z",
  repost: "M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3",
  comment: "M4 5h16v11H8l-4 4z", click: "M9 9l11 4-4.6 1.6L13.8 19zM5 3v3M3 5h3",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z",
  card: "M3 6h18v12H3zM3 10h18", globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18",
  pause: "M8 5v14M16 5v14", play: "M7 4l13 8-13 8z", bolt: "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
};
const Ico = ({ n, s = 16 }: { n: keyof typeof P; s?: number }) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={P[n]} /></svg>
);
const fmt = (n: number) => n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : n.toLocaleString("en-US");
const eur = (n: number) => `€${Math.round(n).toLocaleString("en-US")}`;

/* ---------------- channels ---------------- */
type Ch = "linkedin" | "google" | "instagram" | "facebook" | "whatsapp" | "email" | "tiktok" | "web";
const CH: Record<Ch, { label: string; color: string; short: string }> = {
  linkedin: { label: "LinkedIn", color: "#0a66c2", short: "in" },
  google: { label: "Google Ads", color: "#ea4335", short: "G" },
  instagram: { label: "Instagram", color: "#d62976", short: "IG" },
  facebook: { label: "Facebook", color: "#1877f2", short: "f" },
  whatsapp: { label: "WhatsApp", color: "#25d366", short: "WA" },
  email: { label: "E-mail", color: "#0f9f6e", short: "@" },
  tiktok: { label: "TikTok", color: "#111", short: "TT" },
  web: { label: "Website", color: "#64748b", short: "W" },
};
const ChDot = ({ k, s = 22 }: { k: Ch; s?: number }) => (
  <i className="gr-ch" style={{ ["--c" as string]: CH[k].color, width: s, height: s, fontSize: s * 0.4 }} title={CH[k].label}>{CH[k].short}</i>
);

/* ---------------- sample data ---------------- */
const SOURCES: { k: Ch | "ref"; label: string; n: number; color: string }[] = [
  { k: "linkedin", label: "LinkedIn", n: 41, color: "#0a66c2" },
  { k: "google", label: "Google Ads", n: 33, color: "#ea4335" },
  { k: "web", label: "Website forms", n: 27, color: "#0f9f6e" },
  { k: "instagram", label: "Instagram", n: 19, color: "#d62976" },
  { k: "whatsapp", label: "WhatsApp", n: 14, color: "#25d366" },
  { k: "ref", label: "Referrals", n: 9, color: "#a3a3a3" },
];

type Campaign = {
  id: string; name: string; goal: string; ch: Ch[]; status: "live" | "draft" | "ended";
  spend: number; budget: number; leads: number; reach: number; likes: number; reposts: number;
  comments: number; dms: number; clicks: number; trend: number[];
};
const CAMPAIGNS: Campaign[] = [
  { id: "c1", name: "Power BI reporting demo", goal: "Book demos", ch: ["linkedin", "google", "email"], status: "live", spend: 1240, budget: 2000, leads: 38, reach: 42300, likes: 1210, reposts: 140, comments: 96, dms: 31, clicks: 212, trend: [3, 5, 4, 7, 6, 9, 8, 11, 10, 13] },
  { id: "c2", name: "Year-end close webinar", goal: "Webinar sign-ups", ch: ["linkedin", "instagram", "whatsapp"], status: "live", spend: 610, budget: 900, leads: 24, reach: 18900, likes: 830, reposts: 66, comments: 41, dms: 18, clicks: 120, trend: [2, 2, 3, 5, 4, 6, 7, 6, 8, 9] },
  { id: "c3", name: "Consolidation guide", goal: "Downloads", ch: ["google", "facebook"], status: "ended", spend: 980, budget: 980, leads: 29, reach: 35100, likes: 402, reposts: 22, comments: 17, dms: 6, clicks: 301, trend: [6, 8, 7, 6, 5, 4, 4, 3, 2, 1] },
  { id: "c4", name: "Spring client referral", goal: "Referrals", ch: ["email", "whatsapp"], status: "draft", spend: 0, budget: 400, leads: 0, reach: 0, likes: 0, reposts: 0, comments: 0, dms: 0, clicks: 0, trend: [] },
];

type Health = "good" | "watch" | "risk";
type Client = {
  id: string; name: string; health: Health; arr: number; owner: string; lastDays: number; renewDays: number;
  mails: number; wa: number; mood: string; summary: string[]; next: string;
  touches: { ch: "mail" | "chat" | "phone"; when: string; who: string; text: string }[];
};
const CLIENTS: Client[] = [
  { id: "k1", name: "Aurora Retail", health: "risk", arr: 24000, owner: "Marta", lastDays: 41, renewDays: 38, mails: 9, wa: 3, mood: "Frustrated",
    summary: ["Monthly report arrived late twice (Sep, Oct).", "Finance lead asked for a price review before renewal.", "Wants Power BI access for two more users."],
    next: "Call the finance lead this week: fix the report date and offer the two extra users at the current price.",
    touches: [{ ch: "mail", when: "41 days ago", who: "Laura (Finance)", text: "Asked why the October report was late." }, { ch: "chat", when: "45 days ago", who: "Jorge (CEO)", text: "\"Let's talk about the renewal price.\"" }] },
  { id: "k2", name: "Bahía Industries", health: "watch", arr: 18000, owner: "Íñigo", lastDays: 22, renewDays: 95, mails: 6, wa: 8, mood: "Neutral",
    summary: ["Using the consolidation module every month.", "Two open questions on intercompany eliminations.", "New CFO starts in December."],
    next: "Introduce yourself to the new CFO with a short onboarding session.",
    touches: [{ ch: "chat", when: "22 days ago", who: "Pablo (Controller)", text: "Sent two questions about eliminations." }, { ch: "phone", when: "30 days ago", who: "Pablo (Controller)", text: "Monthly check-in, all fine." }] },
  { id: "k3", name: "Cénit Finance", health: "good", arr: 32000, owner: "Marta", lastDays: 6, renewDays: 210, mails: 14, wa: 2, mood: "Happy",
    summary: ["Very happy with the new dashboards.", "Asked about budgeting (Planning) for 2027.", "Could refer two companies in their group."],
    next: "Send the Planning proposal and ask for the two referrals.",
    touches: [{ ch: "mail", when: "6 days ago", who: "Ana (CFO)", text: "\"The dashboards are great, can we talk Planning?\"" }] },
  { id: "k4", name: "Duna Hotels", health: "good", arr: 15000, owner: "Íñigo", lastDays: 12, renewDays: 160, mails: 5, wa: 6, mood: "Happy",
    summary: ["Closed the year-end with no issues.", "Opening two new hotels in 2027."],
    next: "Offer to add the two new hotels to their reporting.",
    touches: [{ ch: "chat", when: "12 days ago", who: "Sara (Finance)", text: "Thanked the team for the year-end support." }] },
  { id: "k5", name: "Eolo Logistics", health: "risk", arr: 21000, owner: "—", lastDays: 63, renewDays: 21, mails: 2, wa: 0, mood: "Silent",
    summary: ["No reply to the last two e-mails.", "Usage dropped 60% since August."],
    next: "Assign an owner today and call before the renewal (21 days).",
    touches: [{ ch: "mail", when: "63 days ago", who: "Diego (Controller)", text: "Last message: confirmed the August close." }] },
  { id: "k6", name: "Faro Energy", health: "good", arr: 27000, owner: "Marta", lastDays: 9, renewDays: 120, mails: 11, wa: 4, mood: "Happy",
    summary: ["Weekly use by 6 people.", "Asked for training for new hires."],
    next: "Schedule the training session for new hires.",
    touches: [{ ch: "mail", when: "9 days ago", who: "Luis (CFO)", text: "Asked for a training date." }] },
  { id: "k7", name: "Granate Foods", health: "watch", arr: 12000, owner: "Íñigo", lastDays: 34, renewDays: 70, mails: 3, wa: 5, mood: "Neutral",
    summary: ["Mentioned a competitor quote in a WhatsApp.", "Happy with the support, unsure about price."],
    next: "Prepare a value review (hours saved per month) before they compare.",
    touches: [{ ch: "chat", when: "34 days ago", who: "Elena (Finance)", text: "\"We got another quote, let's discuss.\"" }] },
];
const H: Record<Health, { label: string; cls: string }> = { good: { label: "Healthy", cls: "good" }, watch: { label: "Watch", cls: "watch" }, risk: { label: "At risk", cls: "risk" } };

type Seq = { id: string; name: string; who: string; steps: string[]; inside: number; replied: number; on: boolean };
const SEQS: Seq[] = [
  { id: "s1", name: "Renewal in 60 days", who: "Clients renewing in the next 60 days", steps: ["E-mail", "WhatsApp after 3 days", "Call task after 7 days"], inside: 6, replied: 4, on: true },
  { id: "s2", name: "Quiet for 30 days", who: "No contact in 30 days", steps: ["E-mail", "E-mail after 5 days"], inside: 9, replied: 3, on: true },
  { id: "s3", name: "Welcome a new client", who: "Won in the last 7 days", steps: ["E-mail", "Call task after 2 days", "E-mail after 14 days"], inside: 2, replied: 2, on: false },
];

/* ---------------- small pieces ---------------- */
function Spark({ v, w = 90, h = 26 }: { v: number[]; w?: number; h?: number }) {
  if (v.length < 2) return <span className="gr-spark-none" />;
  const mx = Math.max(...v), mn = Math.min(...v);
  const pts = v.map((y, i) => `${(i / (v.length - 1)) * w},${h - 3 - ((y - mn) / (mx - mn || 1)) * (h - 6)}`).join(" ");
  return <svg className="gr-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`}><polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function Kpi({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "up" | "down" }) {
  return <div className="gr-kpi"><span>{label}</span><b>{value}</b>{note && <em className={tone}>{note}</em>}</div>;
}
function Block({ title, sub, action, children, className = "" }: { title: string; sub?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`gr-block ${className}`}>
      <header><div><h3>{title}</h3>{sub && <p>{sub}</p>}</div>{action}</header>
      {children}
    </section>
  );
}
function Panel({ title, sub, onClose, children, foot, wide }: { title: ReactNode; sub?: ReactNode; onClose: () => void; children: ReactNode; foot?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="gr-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className={`gr-panel ${wide ? "is-wide" : ""}`}>
        <header><div><h2>{title}</h2>{sub && <p>{sub}</p>}</div><button className="gr-icon" onClick={onClose} aria-label="Close"><Ico n="x" /></button></header>
        <div className="gr-panel-body">{children}</div>
        {foot && <footer>{foot}</footer>}
      </aside>
    </div>
  );
}
const Pill = ({ h }: { h: Health }) => <span className={`gr-pill ${H[h].cls}`}><i />{H[h].label}</span>;

/* =====================================================================
   Page
   ===================================================================== */
type Sec = "overview" | "campaigns" | "ads" | "website" | "customers" | "followups";
const SECS: { k: Sec; label: string; group?: "Attract" | "Keep" }[] = [
  { k: "overview", label: "Overview" },
  { k: "campaigns", label: "Campaigns", group: "Attract" },
  { k: "ads", label: "Ads", group: "Attract" },
  { k: "website", label: "Website", group: "Attract" },
  { k: "customers", label: "Customers", group: "Keep" },
  { k: "followups", label: "Follow-ups", group: "Keep" },
];
const BRANDS = [{ name: "Brazo", color: "#0f9f6e" }, { name: "Brazo Reporting", color: "#5b6ee1" }, { name: "Brazo Academy", color: "#d48a1e" }];

export default function GrowthPage() {
  const [sp, setSp] = useSearchParams();
  const sec = (SECS.some((s) => s.k === sp.get("s")) ? sp.get("s") : "overview") as Sec;
  const go = (k: Sec) => setSp((p) => { const n = new URLSearchParams(p); if (k === "overview") n.delete("s"); else n.set("s", k); return n; }, { replace: true });
  const [toast, setToast] = useState("");
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(""), 2600); return () => clearTimeout(t); }, [toast]);
  const [brand, setBrand] = useState(0);
  const [brandOpen, setBrandOpen] = useState(false);
  const [camps, setCamps] = useState(CAMPAIGNS);
  const [studio, setStudio] = useState(false);
  const [client, setClient] = useState<Client | null>(null);

  return (
    <div className="gr">
      <header className="gr-top">
        <div className="gr-title">
          <h1>Growth</h1>
          <p>Win new clients and keep the ones you have</p>
        </div>
        <div className="gr-brand">
          <button onClick={() => setBrandOpen((o) => !o)}><i style={{ background: BRANDS[brand].color }}>{BRANDS[brand].name[0]}</i>{BRANDS[brand].name}<Ico n="down" s={14} /></button>
          {brandOpen && (
            <div className="gr-pop" onMouseLeave={() => setBrandOpen(false)}>
              {BRANDS.map((b, i) => (
                <button key={b.name} className={i === brand ? "is-on" : ""} onClick={() => { setBrand(i); setBrandOpen(false); }}>
                  <i style={{ background: b.color }}>{b.name[0]}</i>{b.name}{i === brand && <Ico n="check" s={14} />}
                </button>
              ))}
              <button className="gr-pop-add" onClick={() => { setBrandOpen(false); setToast("Adding brands comes with the live version"); }}><Ico n="plus" s={14} />Add a brand</button>
            </div>
          )}
        </div>
        <span className="gr-grow" />
        <span className="gr-preview" title="Sample figures — channels are not connected yet">Preview</span>
        <button className="gr-btn" onClick={() => setStudio(true)}><Ico n="spark" />New campaign</button>
      </header>

      <nav className="gr-tabs">
        {SECS.map((s, i) => (
          <span key={s.k} className="gr-tab-wrap">
            {s.group && s.group !== SECS[i - 1]?.group && <em>{s.group}</em>}
            <button className={sec === s.k ? "is-on" : ""} onClick={() => go(s.k)}>{s.label}</button>
          </span>
        ))}
      </nav>

      <main className="gr-main" key={sec}>
        {sec === "overview" && <Overview camps={camps} go={go} openClient={setClient} openStudio={() => setStudio(true)} toast={setToast} />}
        {sec === "campaigns" && <Campaigns camps={camps} setCamps={setCamps} openStudio={() => setStudio(true)} toast={setToast} />}
        {sec === "ads" && <Ads toast={setToast} />}
        {sec === "website" && <Website toast={setToast} />}
        {sec === "customers" && <Customers open={setClient} />}
        {sec === "followups" && <FollowUps toast={setToast} />}
      </main>

      {studio && <Studio onClose={() => setStudio(false)} onLaunch={(c) => { setCamps((x) => [c, ...x]); setStudio(false); go("campaigns"); setToast(`"${c.name}" is live`); }} />}
      {client && <ClientPanel c={client} onClose={() => setClient(null)} toast={setToast} />}
      {toast && <div className="gr-toast"><Ico n="check" s={15} />{toast}</div>}
    </div>
  );
}

/* =====================================================================
   Overview
   ===================================================================== */
function Overview({ camps, go, openClient, openStudio, toast }: { camps: Campaign[]; go: (k: Sec) => void; openClient: (c: Client) => void; openStudio: () => void; toast: (s: string) => void }) {
  const leads = SOURCES.reduce((a, s) => a + s.n, 0);
  const spend = camps.reduce((a, c) => a + c.spend, 0);
  const atRisk = CLIENTS.filter((c) => c.health === "risk");
  const healthy = CLIENTS.filter((c) => c.health === "good").length;
  const max = Math.max(...SOURCES.map((s) => s.n));
  const todo = [
    ...atRisk.map((c) => ({ id: c.id, tone: "risk", text: <><b>{c.name}</b> is at risk · renews in {c.renewDays} days</>, act: "Open", run: () => openClient(c) })),
    { id: "a1", tone: "info", text: <><b>Power BI demo</b> gets leads 40% cheaper on LinkedIn than Google</>, act: "Move budget", run: () => toast("Moved €300 from Google to LinkedIn") },
    { id: "a2", tone: "info", text: <><b>3 posts</b> are ready to publish this week</>, act: "Review", run: () => go("campaigns") },
  ];
  return (
    <div className="gr-ov">
      <div className="gr-kpis">
        <Kpi label="New leads · 30 days" value={String(leads)} note="+18% vs last month" tone="up" />
        <Kpi label="Cost per lead" value={eur(spend / Math.max(1, camps.reduce((a, c) => a + c.leads, 0)))} note="−€4 vs last month" tone="up" />
        <Kpi label="Healthy clients" value={`${healthy} of ${CLIENTS.length}`} note={`${atRisk.length} at risk`} tone="down" />
        <Kpi label="Revenue at risk" value={eur(atRisk.reduce((a, c) => a + c.arr, 0))} note="renewing in < 60 days" />
      </div>

      <div className="gr-two">
        <Block title="Needs you" sub="The few things worth doing today">
          <ul className="gr-todo">
            {todo.map((t, i) => (
              <li key={t.id} style={{ ["--i" as string]: i }}>
                <i className={t.tone} />
                <span>{t.text}</span>
                <button className="gr-link" onClick={t.run}>{t.act}<Ico n="chev" s={13} /></button>
              </li>
            ))}
          </ul>
        </Block>

        <Block title="Where leads come from" sub={`${leads} leads in the last 30 days`} action={<button className="gr-link" onClick={() => go("campaigns")}>Campaigns<Ico n="chev" s={13} /></button>}>
          <ul className="gr-src">
            {SOURCES.map((s, i) => (
              <li key={s.k} style={{ ["--i" as string]: i }}>
                <span>{s.label}</span>
                <div><i style={{ width: `${(s.n / max) * 100}%`, background: s.color }} /></div>
                <b>{s.n}</b>
              </li>
            ))}
          </ul>
        </Block>
      </div>

      <div className="gr-ai" onClick={openStudio} role="button">
        <span className="gr-ai-ico"><Ico n="spark" s={18} /></span>
        <div><b>Next campaign idea</b><p>Your webinar audience replies most on WhatsApp. A 3-message WhatsApp follow-up could bring ~12 more demos.</p></div>
        <button className="gr-btn ghost">Create it<Ico n="chev" s={14} /></button>
      </div>
    </div>
  );
}

/* =====================================================================
   Campaigns (list → detail panel) · Studio (new campaign, step by step)
   ===================================================================== */
function Campaigns({ camps, setCamps, openStudio, toast }: { camps: Campaign[]; setCamps: (f: (c: Campaign[]) => Campaign[]) => void; openStudio: () => void; toast: (s: string) => void }) {
  const [open, setOpen] = useState<Campaign | null>(null);
  const [f, setF] = useState<"all" | Campaign["status"]>("all");
  const list = camps.filter((c) => f === "all" || c.status === f);
  const toggle = (c: Campaign) => { setCamps((x) => x.map((y) => y.id === c.id ? { ...y, status: y.status === "live" ? "ended" : "live" } : y)); toast(c.status === "live" ? "Campaign paused" : "Campaign live again"); };
  return (
    <>
      <div className="gr-bar">
        <div className="gr-chips">
          {(["all", "live", "draft", "ended"] as const).map((k) => (
            <button key={k} className={f === k ? "is-on" : ""} onClick={() => setF(k)}>{k === "all" ? "All" : k[0].toUpperCase() + k.slice(1)}<small>{k === "all" ? camps.length : camps.filter((c) => c.status === k).length}</small></button>
          ))}
        </div>
      </div>
      <div className="gr-table">
        <div className="gr-tr gr-th c-camp"><span>Campaign</span><span>Channels</span><span>Spend</span><span>Leads</span><span>Cost / lead</span><span>Last 10 days</span></div>
        {list.map((c, i) => (
          <button key={c.id} className="gr-tr c-camp" style={{ ["--i" as string]: i }} onClick={() => setOpen(c)}>
            <span className="gr-name"><b>{c.name}</b><small><i className={`gr-st ${c.status}`} />{c.status === "live" ? "Live" : c.status === "draft" ? "Draft" : "Ended"} · {c.goal}</small></span>
            <span className="gr-chs">{c.ch.map((k) => <ChDot key={k} k={k} />)}</span>
            <span>{c.spend ? eur(c.spend) : "—"}<small> / {eur(c.budget)}</small></span>
            <span className="gr-num">{c.leads || "—"}</span>
            <span>{c.leads ? eur(c.spend / c.leads) : "—"}</span>
            <span className="gr-trend"><Spark v={c.trend} /></span>
          </button>
        ))}
        <button className="gr-tr gr-add" onClick={openStudio}><Ico n="plus" />New campaign — describe it, the AI does the rest</button>
      </div>
      {open && <CampaignPanel c={camps.find((x) => x.id === open.id) || open} onClose={() => setOpen(null)} onToggle={toggle} toast={toast} />}
    </>
  );
}

function CampaignPanel({ c, onClose, onToggle, toast }: { c: Campaign; onClose: () => void; onToggle: (c: Campaign) => void; toast: (s: string) => void }) {
  const eng: { n: keyof typeof P; label: string; v: number }[] = [
    { n: "eye", label: "Reach", v: c.reach }, { n: "heart", label: "Likes", v: c.likes }, { n: "repost", label: "Reposts", v: c.reposts },
    { n: "comment", label: "Comments", v: c.comments }, { n: "chat", label: "DMs", v: c.dms }, { n: "click", label: "Demo clicks", v: c.clicks },
  ];
  const funnel = [{ l: "Saw it", v: c.reach }, { l: "Interacted", v: c.likes + c.comments + c.reposts }, { l: "Clicked", v: c.clicks }, { l: "Became a lead", v: c.leads }];
  return (
    <Panel title={c.name} sub={<>{c.goal} · {c.ch.map((k) => CH[k].label).join(", ")}</>} onClose={onClose} wide
      foot={c.status !== "draft" && <><span className="gr-grow" /><button className="gr-btn ghost" onClick={() => onToggle(c)}><Ico n={c.status === "live" ? "pause" : "play"} s={14} />{c.status === "live" ? "Pause" : "Resume"}</button></>}>
      {c.status === "draft" ? <p className="gr-empty">This campaign hasn't started. Its posts are ready to review.</p> : <>
        <div className="gr-eng">{eng.map((e) => <div key={e.label}><Ico n={e.n} s={15} /><b>{fmt(e.v)}</b><span>{e.label}</span></div>)}</div>
        <h4 className="gr-h4">From seeing it to becoming a lead</h4>
        <div className="gr-funnel">
          {funnel.map((s) => <div key={s.l}><span>{s.l}</span><div><i style={{ width: `${Math.max(2, (Math.log10(s.v + 1) / Math.log10(c.reach + 1)) * 100)}%` }} /></div><b>{fmt(s.v)}</b></div>)}
        </div>
        <h4 className="gr-h4">By channel</h4>
        <div className="gr-bych">
          {c.ch.map((k, i) => { const share = [0.5, 0.32, 0.18][i] || 0.1; return (
            <div key={k}><ChDot k={k} /><span>{CH[k].label}</span><b>{Math.round(c.leads * share)} leads</b><small>{eur((c.spend * share) / Math.max(1, Math.round(c.leads * share)))} / lead</small></div>
          ); })}
        </div>
        <div className="gr-advice">
          <span className="gr-ai-ico"><Ico n="spark" s={16} /></span>
          <div><b>AI advice</b><p>Posts with a client quote get 2× more comments. Turn the top LinkedIn post into a Google ad and move €200 there.</p></div>
          <button className="gr-btn small" onClick={() => toast("Advice applied: new ad created, budget moved")}>Apply</button>
        </div>
      </>}
    </Panel>
  );
}

const IDEAS = ["Invite CFOs to a 30-minute Power BI demo", "Promote our year-end close webinar", "Ask happy clients for referrals"];
function Studio({ onClose, onLaunch }: { onClose: () => void; onLaunch: (c: Campaign) => void }) {
  const [step, setStep] = useState(0);
  const [brief, setBrief] = useState("");
  const [ch, setCh] = useState<Ch[]>(["linkedin", "google", "email"]);
  const [budget, setBudget] = useState(800);
  const [weeks, setWeeks] = useState(3);
  const [busy, setBusy] = useState(false);
  const steps = ["What", "Where", "Budget", "Review"];
  const ok = [brief.trim().length > 8, ch.length > 0, budget > 0, true][step];
  useEffect(() => { if (step === 3) { setBusy(true); const t = setTimeout(() => setBusy(false), 1400); return () => clearTimeout(t); } }, [step]);
  const name = brief.trim().split(" ").slice(0, 5).join(" ").replace(/^\w/, (m) => m.toUpperCase());
  const leads = Math.round(budget / 26);
  const posts = useMemo(() => ch.slice(0, 3).map((k, i) => ({
    k, day: ["Mon", "Wed", "Fri"][i],
    text: [
      "Closing the month shouldn't take 10 days. See how in 30 minutes, with real numbers.",
      `"We went from spreadsheets to one dashboard in 3 weeks." — a client CFO. Book your demo.`,
      `Last seats this week. Reply YES and we'll send you the link.`,
    ][i],
  })), [ch, name]);
  const launch = () => onLaunch({ id: `n${Date.now()}`, name: name || "New campaign", goal: "Leads", ch, status: "live", spend: 0, budget, leads: 0, reach: 0, likes: 0, reposts: 0, comments: 0, dms: 0, clicks: 0, trend: [] });
  return (
    <Panel title="New campaign" sub="Tell us what you want — the AI writes, designs and schedules it" onClose={onClose}
      foot={<>
        {step > 0 && <button className="gr-btn ghost" onClick={() => setStep(step - 1)}><Ico n="back" s={14} />Back</button>}
        <span className="gr-grow" />
        {step < 3 ? <button className="gr-btn" disabled={!ok} onClick={() => setStep(step + 1)}>Next<Ico n="chev" s={14} /></button>
          : <button className="gr-btn" disabled={busy} onClick={launch}><Ico n="bolt" s={14} />Launch</button>}
      </>}>
      <ol className="gr-steps">{steps.map((s, i) => <li key={s} className={i === step ? "is-on" : i < step ? "is-done" : ""}><i>{i < step ? <Ico n="check" s={12} /> : i + 1}</i>{s}</li>)}</ol>

      {step === 0 && <div className="gr-q">
        <label>What do you want to achieve?</label>
        <textarea autoFocus rows={4} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="e.g. Invite CFOs of mid-size companies to a 30-minute Power BI demo in November" />
        <div className="gr-ideas">{IDEAS.map((t) => <button key={t} onClick={() => setBrief(t)}>{t}</button>)}</div>
      </div>}

      {step === 1 && <div className="gr-q">
        <label>Where should it run?</label>
        <div className="gr-pick">
          {(["linkedin", "google", "instagram", "facebook", "whatsapp", "email", "tiktok"] as Ch[]).map((k) => (
            <button key={k} className={ch.includes(k) ? "is-on" : ""} onClick={() => setCh((x) => x.includes(k) ? x.filter((y) => y !== k) : [...x, k])}>
              <ChDot k={k} s={26} /><span>{CH[k].label}</span>{ch.includes(k) && <Ico n="check" s={14} />}
            </button>
          ))}
        </div>
        <p className="gr-hint">For a B2B demo, LinkedIn and Google usually bring the cheapest leads.</p>
      </div>}

      {step === 2 && <div className="gr-q">
        <label>How much, for how long?</label>
        <div className="gr-range"><span>Budget</span><input type="range" min={100} max={5000} step={50} value={budget} onChange={(e) => setBudget(+e.target.value)} /><b>{eur(budget)}</b></div>
        <div className="gr-range"><span>Duration</span><input type="range" min={1} max={8} value={weeks} onChange={(e) => setWeeks(+e.target.value)} /><b>{weeks} week{weeks > 1 ? "s" : ""}</b></div>
        <div className="gr-expect"><div><b>~{fmt(budget * 38)}</b><span>people reached</span></div><div><b>~{leads}</b><span>leads</span></div><div><b>~{eur(budget / Math.max(1, leads))}</b><span>per lead</span></div></div>
        <p className="gr-hint">Paid from your Growth wallet. You can pause at any moment.</p>
      </div>}

      {step === 3 && (busy ? <div className="gr-gen"><span className="gr-spin" /><b>Writing posts, making visuals, planning the schedule…</b></div> : <div className="gr-q">
        <label>Here's your campaign</label>
        <div className="gr-posts">
          {posts.map((p, i) => (
            <div key={i} className="gr-post" style={{ ["--i" as string]: i }}>
              <header><ChDot k={p.k} /><b>{CH[p.k].label}</b><small>{p.day}</small></header>
              <div className="gr-post-img" style={{ ["--c" as string]: CH[p.k].color }}><span>{name || "Your campaign"}</span></div>
              <p>{p.text}</p>
            </div>
          ))}
        </div>
        <div className="gr-sum"><span>{ch.length} channels · {weeks} weeks · {eur(budget)}</span><span>Expected <b>~{leads} leads</b></span></div>
        <p className="gr-hint">Agents keep it running: they answer comments and DMs, refresh visuals and move budget to what works.</p>
      </div>)}
    </Panel>
  );
}

/* =====================================================================
   Ads — wallet + ad accounts
   ===================================================================== */
function Ads({ toast }: { toast: (s: string) => void }) {
  const [bal, setBal] = useState(1850);
  const [top, setTop] = useState(false);
  const [acc, setAcc] = useState([
    { k: "facebook" as Ch, name: "Meta Ads", sub: "Facebook + Instagram", on: true, spend: 640 },
    { k: "google" as Ch, name: "Google Ads", sub: "Search and display", on: true, spend: 820 },
    { k: "linkedin" as Ch, name: "LinkedIn Ads", sub: "Sponsored posts, InMail", on: true, spend: 1370 },
    { k: "tiktok" as Ch, name: "TikTok Ads", sub: "Short videos", on: false, spend: 0 },
  ]);
  const total = acc.reduce((a, x) => a + x.spend, 0);
  return (
    <div className="gr-ads">
      <div className="gr-wallet">
        <span>Wallet</span>
        <b>{eur(bal)}</b>
        <p>Pays every ad account from one place. Enough for ~{Math.round(bal / 95)} days at today's pace.</p>
        <div><button className="gr-btn" onClick={() => setTop(true)}><Ico n="plus" s={14} />Add funds</button><button className="gr-btn ghost" onClick={() => toast("Auto top-up on: €500 when below €200")}>Auto top-up</button></div>
      </div>
      <Block title="Ad accounts" sub={`${eur(total)} spent this month`}>
        <ul className="gr-acc">
          {acc.map((a) => (
            <li key={a.name}>
              <ChDot k={a.k} s={30} />
              <div><b>{a.name}</b><small>{a.sub}</small></div>
              {a.on ? <><div className="gr-acc-bar"><i style={{ width: `${(a.spend / total) * 100}%`, background: CH[a.k].color }} /></div><span className="gr-num">{eur(a.spend)}</span></>
                : <button className="gr-btn ghost small" onClick={() => { setAcc((x) => x.map((y) => y.name === a.name ? { ...y, on: true } : y)); toast(`${a.name} connected`); }}>Connect</button>}
            </li>
          ))}
        </ul>
      </Block>
      {top && <Panel title="Add funds" sub="Card on file ending 4242" onClose={() => setTop(false)}>
        <div className="gr-amounts">{[250, 500, 1000, 2500].map((v) => <button key={v} onClick={() => { setBal((b) => b + v); setTop(false); toast(`${eur(v)} added to the wallet`); }}>{eur(v)}</button>)}</div>
        <p className="gr-hint">Funds are only spent by campaigns you launch. Unused funds can be withdrawn.</p>
      </Panel>}
    </div>
  );
}

/* =====================================================================
   Website — generate the site
   ===================================================================== */
function Website({ toast }: { toast: (s: string) => void }) {
  const [prompt, setPrompt] = useState("Consultancy that builds financial reporting and consolidation in Power BI for mid-size companies");
  const [style, setStyle] = useState("Clean");
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const go = () => { setState("busy"); setTimeout(() => setState("done"), 1600); };
  return (
    <div className="gr-web">
      <Block title="Your website" sub="Describe your company — get a site whose forms drop leads straight into Orbit">
        <div className="gr-q">
          <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <div className="gr-web-row">
            <div className="gr-chips">{["Clean", "Bold", "Classic"].map((s) => <button key={s} className={style === s ? "is-on" : ""} onClick={() => setStyle(s)}>{s}</button>)}</div>
            <span className="gr-grow" />
            <button className="gr-btn" disabled={state === "busy"} onClick={go}><Ico n="spark" s={14} />{state === "done" ? "Make another" : "Generate"}</button>
          </div>
        </div>
      </Block>
      {state !== "idle" && <div className={`gr-browser ${style.toLowerCase()}`}>
        <div className="gr-browser-bar"><i /><i /><i /><span>brazo.next.site</span>{state === "done" && <button className="gr-btn small" onClick={() => toast("Published at brazo.next.site")}><Ico n="globe" s={14} />Publish</button>}</div>
        {state === "busy" ? <div className="gr-gen"><span className="gr-spin" /><b>Writing pages, picking images…</b></div> : <div className="gr-site">
          <nav><b>Brazo</b><span>Services</span><span>Clients</span><span>About</span><em>Book a demo</em></nav>
          <div className="gr-site-hero"><h2>Your month-end, closed in days — not weeks.</h2><p>Financial reporting and consolidation in Power BI, built for mid-size companies.</p><em>Book a 30-minute demo</em></div>
          <div className="gr-site-cards"><div><b>Reporting</b><span>One dashboard for every entity.</span></div><div><b>Consolidation</b><span>Eliminations done for you.</span></div><div><b>Planning</b><span>Budgets everyone can follow.</span></div></div>
        </div>}
      </div>}
    </div>
  );
}

/* =====================================================================
   Customers — health list → client panel with AI summary of talks
   ===================================================================== */
function Customers({ open }: { open: (c: Client) => void }) {
  const [f, setF] = useState<"all" | Health>("all");
  const [q, setQ] = useState("");
  const list = CLIENTS.filter((c) => (f === "all" || c.health === f) && c.name.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => ({ risk: 0, watch: 1, good: 2 }[a.health] - { risk: 0, watch: 1, good: 2 }[b.health]) || a.renewDays - b.renewDays);
  const n = (h: Health) => CLIENTS.filter((c) => c.health === h).length;
  return (
    <>
      <div className="gr-health">
        {(["good", "watch", "risk"] as Health[]).map((h) => (
          <button key={h} className={`${H[h].cls} ${f === h ? "is-on" : ""}`} onClick={() => setF(f === h ? "all" : h)}>
            <b>{n(h)}</b><span>{H[h].label}</span><small>{eur(CLIENTS.filter((c) => c.health === h).reduce((a, c) => a + c.arr, 0))} a year</small>
          </button>
        ))}
      </div>
      <div className="gr-bar">
        <input className="gr-search" placeholder="Find a client…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="gr-table">
        <div className="gr-tr gr-th c-cli"><span>Client</span><span>Health</span><span>Last contact</span><span>Renews in</span><span>Owner</span><span /></div>
        {list.map((c, i) => (
          <button key={c.id} className="gr-tr c-cli" style={{ ["--i" as string]: i }} onClick={() => open(c)}>
            <span className="gr-name"><b>{c.name}</b><small>{eur(c.arr)} a year</small></span>
            <span><Pill h={c.health} /></span>
            <span className={c.lastDays > 30 ? "gr-warn" : ""}>{c.lastDays} days ago</span>
            <span className={c.renewDays < 45 ? "gr-warn" : ""}>{c.renewDays} days</span>
            <span className={c.owner === "—" ? "gr-warn" : ""}>{c.owner === "—" ? "No owner" : c.owner}</span>
            <span className="gr-go"><Ico n="chev" s={15} /></span>
          </button>
        ))}
        {!list.length && <p className="gr-empty">No clients match.</p>}
      </div>
    </>
  );
}

function ClientPanel({ c, onClose, toast }: { c: Client; onClose: () => void; toast: (s: string) => void }) {
  return (
    <Panel title={c.name} sub={<><Pill h={c.health} /> · {eur(c.arr)} a year · renews in {c.renewDays} days</>} onClose={onClose} wide
      foot={<><button className="gr-btn ghost" onClick={() => toast("Call task created for today")}><Ico n="phone" s={14} />Plan a call</button><span className="gr-grow" /><button className="gr-btn" onClick={() => toast("Draft e-mail ready in your outbox")}><Ico n="mail" s={14} />Draft e-mail</button></>}>
      <div className="gr-summary">
        <header><span className="gr-ai-ico"><Ico n="spark" s={15} /></span><b>What you've talked about</b><small>{c.mails} e-mails · {c.wa} WhatsApp · last 90 days</small></header>
        <ul>{c.summary.map((s) => <li key={s}>{s}</li>)}</ul>
        <div className="gr-mood">Mood <b>{c.mood}</b></div>
      </div>
      <div className="gr-next"><b>Suggested next step</b><p>{c.next}</p></div>
      <h4 className="gr-h4">Latest contact</h4>
      <ul className="gr-touch">
        {c.touches.map((t, i) => (
          <li key={i}><i><Ico n={t.ch} s={14} /></i><div><b>{t.who}</b><span>{t.text}</span></div><small>{t.when}</small></li>
        ))}
      </ul>
    </Panel>
  );
}

/* =====================================================================
   Follow-ups — automatic sequences
   ===================================================================== */
function FollowUps({ toast }: { toast: (s: string) => void }) {
  const [seqs, setSeqs] = useState(SEQS);
  const [edit, setEdit] = useState(false);
  const [who, setWho] = useState("Renewing in the next 60 days");
  const [steps, setSteps] = useState([{ ch: "mail", wait: 0 }, { ch: "chat", wait: 3 }, { ch: "phone", wait: 7 }]);
  const CHN: Record<string, string> = { mail: "E-mail", chat: "WhatsApp", phone: "Call task" };
  const save = () => {
    setSeqs((x) => [...x, { id: `s${Date.now()}`, name: who, who, steps: steps.map((s, i) => i === 0 ? CHN[s.ch] : `${CHN[s.ch]} after ${s.wait} days`), inside: 0, replied: 0, on: true }]);
    setEdit(false); toast("Follow-up saved and on");
  };
  return (
    <>
      <div className="gr-rule"><Ico n="user" s={15} /><span>A follow-up stops when <b>anyone at the client</b> replies — not just the person it was sent to.</span></div>
      <div className="gr-seqs">
        {seqs.map((s, i) => (
          <div key={s.id} className={`gr-seq ${s.on ? "" : "is-off"}`} style={{ ["--i" as string]: i }}>
            <header><b>{s.name}</b><button className={`gr-switch ${s.on ? "is-on" : ""}`} onClick={() => setSeqs((x) => x.map((y) => y.id === s.id ? { ...y, on: !y.on } : y))} aria-label="On/off"><i /></button></header>
            <p>{s.who}</p>
            <ol>{s.steps.map((st) => <li key={st}>{st}</li>)}</ol>
            <footer><span><b>{s.inside}</b> clients in it</span><span><b>{s.inside ? Math.round((s.replied / s.inside) * 100) : 0}%</b> replied</span></footer>
          </div>
        ))}
        <button className="gr-seq gr-seq-add" onClick={() => setEdit(true)}><Ico n="plus" s={18} />New follow-up</button>
      </div>
      {edit && <Panel title="New follow-up" sub="Who gets it and what happens, step by step" onClose={() => setEdit(false)}
        foot={<><span className="gr-grow" /><button className="gr-btn" onClick={save}><Ico n="check" s={14} />Save and turn on</button></>}>
        <div className="gr-q">
          <label>Who</label>
          <div className="gr-chips wrap">{["Renewing in the next 60 days", "No contact in 30 days", "At risk", "New clients"].map((w) => <button key={w} className={who === w ? "is-on" : ""} onClick={() => setWho(w)}>{w}</button>)}</div>
          <label>Steps</label>
          <ol className="gr-flow">
            {steps.map((s, i) => (
              <li key={i}>
                <i>{i + 1}</i>
                <select value={s.ch} onChange={(e) => setSteps((x) => x.map((y, j) => j === i ? { ...y, ch: e.target.value } : y))}>{Object.entries(CHN).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                {i > 0 ? <span>after <input type="number" min={1} value={s.wait} onChange={(e) => setSteps((x) => x.map((y, j) => j === i ? { ...y, wait: +e.target.value } : y))} /> days with no reply</span> : <span>right away</span>}
                {i > 0 && <button className="gr-icon" onClick={() => setSteps((x) => x.filter((_, j) => j !== i))} aria-label="Remove"><Ico n="x" s={14} /></button>}
              </li>
            ))}
          </ol>
          <button className="gr-link" onClick={() => setSteps((x) => [...x, { ch: "mail", wait: 5 }])}><Ico n="plus" s={13} />Add a step</button>
          <p className="gr-hint">The AI writes each message from what you've talked about with that client. You can review them before they go.</p>
        </div>
      </Panel>}
    </>
  );
}
