/* =====================================================================
   BASE · Marketing — the "agent" side, as a MOCK (sample data, nothing
   is sent, paid or published yet). It sits inside the Marketing page
   (pages/contacts/ContactExport.tsx · MarketingPage) as extra tabs:
     Studio   — one sentence → a whole campaign on every channel
                (copy, visuals, schedule, budget), launched in one click;
                the agents (community manager, designer, copywriter, ads
                optimiser) that keep it running
     Ads      — ad accounts (Meta, Google, LinkedIn, TikTok) paid from here
     Results  — reach, likes, reposts, comments, DMs, demo clicks, leads,
                cost per lead, by campaign and channel; AI advice
     Website  — generate the company's website (leads go to the CRM)
   Plus: where each lead comes from (LeadStrip, on Overview) and more than
   one brand / account (AccountSwitch, in the header).
   ===================================================================== */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "./MarketingLab.css";

/* ---------------- channels ---------------- */
export type ChKey = "instagram" | "facebook" | "linkedin" | "google" | "whatsapp" | "email" | "tiktok" | "x";
export const CH: Record<ChKey, { label: string; color: string; short: string; kind: string }> = {
  instagram: { label: "Instagram", color: "#d62976", short: "IG", kind: "Posts, reels, stories" },
  facebook: { label: "Facebook", color: "#1877f2", short: "f", kind: "Posts and ads" },
  linkedin: { label: "LinkedIn", color: "#0a66c2", short: "in", kind: "Posts, ads, InMail" },
  google: { label: "Google Ads", color: "#ea4335", short: "G", kind: "Search and display" },
  whatsapp: { label: "WhatsApp", color: "#25d366", short: "WA", kind: "Broadcasts and chats" },
  email: { label: "E-mail", color: "#12b57f", short: "@", kind: "Campaigns to your lists" },
  tiktok: { label: "TikTok", color: "#111111", short: "TT", kind: "Short videos" },
  x: { label: "X", color: "#14171a", short: "X", kind: "Posts" },
};
const ALL: ChKey[] = ["instagram", "facebook", "linkedin", "google", "whatsapp", "email", "tiktok", "x"];

const Ico = ({ d, s = 16 }: { d: string; s?: number }) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const I = {
  spark: "M12 3l1.8 4.9L19 9.7l-5.2 1.8L12 16.4l-1.8-4.9L5 9.7l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
  rocket: "M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2M9 13l2 2M14.5 4.5c2.5-1.5 5-1.5 5-1.5s0 2.5-1.5 5L12 14l-4-4z",
  check: "M5 12.5l4.2 4.2L19 7", chev: "M6 9l6 6 6-6", plus: "M12 5v14M5 12h14",
  heart: "M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z",
  repost: "M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3",
  comment: "M4 5h16v11H8l-4 4z", dm: "M4 6l8 6 8-6M4 6h16v12H4z", click: "M9 9l11 4-4.6 1.6L13.8 19zM5 3v3M3 5h3",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  euro: "M18 6.5A7 7 0 1 0 18 17.5M4 10h10M4 14h10", card: "M3 6h18v12H3zM3 10h18M7 15h3",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18",
  bolt: "M13 2L3 14h9l-1 8 10-12h-9l1-8z", pause: "M8 5v14M16 5v14", play: "M7 4l13 8-13 8z",
  wand: "M15 4V2M15 10V8M11 6h2M17 6h2M4 20L14.5 9.5M16 13l.5 1.5L18 15l-1.5.5L16 17l-.5-1.5L14 15l1.5-.5z",
  brush: "M18 2l4 4-9 9-4-4zM9 11c-3 0-5 2-5 5 0 1.5-1 2.5-2 3 4 1 9 0 9-5", pen: "M4 20h4L19 9l-4-4L4 16z",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2", target: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 11.5v1",
  layers: "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5", link: "M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1",
};
const fmt = (n: number) => n.toLocaleString("en-US");
const eur = (n: number) => `€${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

/** "Preview": nothing here is live yet. */
const Preview = ({ what }: { what: string }) => (
  <div className="ml-preview"><i>Preview</i><span>{what} — sample figures; connecting the channels comes next.</span></div>
);
const ChDot = ({ k, s = 26 }: { k: ChKey; s?: number }) => (
  <i className="ml-ch" style={{ ["--cc" as string]: CH[k].color, width: s, height: s, fontSize: s * 0.38 }} title={CH[k].label}>{CH[k].short}</i>
);

/* ===================================================================
   Header: brands / accounts (multi-account)
   =================================================================== */
const ACCOUNTS = [
  { id: "a1", name: "Brazo", sub: "Main brand · 6 channels", color: "#12b57f" },
  { id: "a2", name: "Brazo Reporting", sub: "Product brand · 3 channels", color: "#5b6ee1" },
  { id: "a3", name: "Brazo Academy", sub: "Training · 2 channels", color: "#e0a13c" },
];
export function AccountSwitch() {
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState(ACCOUNTS[0]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  return (
    <div className="ml-acc" ref={ref}>
      <button type="button" className="ml-acc-btn" onClick={() => setOpen(!open)} aria-expanded={open} title="Brand / account">
        <i style={{ background: cur.color }}>{cur.name[0]}</i><span>{cur.name}</span><Ico d={I.chev} s={14} />
      </button>
      {open && (
        <div className="ml-acc-pop">
          <small>Brands &amp; accounts</small>
          {ACCOUNTS.map((a) => (
            <button key={a.id} type="button" className={a.id === cur.id ? "is-on" : ""} onClick={() => { setCur(a); setOpen(false); }}>
              <i style={{ background: a.color }}>{a.name[0]}</i><span><b>{a.name}</b><em>{a.sub}</em></span>{a.id === cur.id && <Ico d={I.check} s={14} />}
            </button>
          ))}
          <button type="button" className="ml-acc-add"><Ico d={I.plus} s={14} />Add a brand or client account</button>
        </div>
      )}
    </div>
  );
}

/* ===================================================================
   Overview strip: where the leads come from
   =================================================================== */
const SOURCES: { k: ChKey | "web" | "referral"; label: string; leads: number; color: string }[] = [
  { k: "linkedin", label: "LinkedIn", leads: 41, color: CH.linkedin.color },
  { k: "google", label: "Google Ads", leads: 33, color: CH.google.color },
  { k: "web", label: "Website forms", leads: 27, color: "#0a6f4d" },
  { k: "instagram", label: "Instagram", leads: 19, color: CH.instagram.color },
  { k: "whatsapp", label: "WhatsApp", leads: 14, color: CH.whatsapp.color },
  { k: "email", label: "E-mail campaigns", leads: 12, color: CH.email.color },
  { k: "referral", label: "Referrals", leads: 9, color: "#9a7d4b" },
];
export function LeadStrip({ onResults }: { onResults?: () => void }) {
  const total = SOURCES.reduce((a, s) => a + s.leads, 0);
  return (
    <section className="ml-leads">
      <header>
        <span className="ml-leads-ico"><Ico d={I.target} s={17} /></span>
        <div><b>Where your leads come from</b><small>Last 30 days · {total} new leads · every lead keeps its source in Orbit</small></div>
        {onResults && <button type="button" className="ml-ghost" onClick={onResults}>See results<Ico d="M9 6l6 6-6 6" s={14} /></button>}
      </header>
      <div className="ml-leads-bar">
        {SOURCES.map((s, i) => <i key={s.k} style={{ flex: s.leads, background: s.color, ["--i" as string]: i }} title={`${s.label}: ${s.leads}`} />)}
      </div>
      <div className="ml-leads-legend">
        {SOURCES.map((s) => (
          <span key={s.k}><i style={{ background: s.color }} />{s.label}<b>{s.leads}</b><em>{Math.round((s.leads / total) * 100)}%</em></span>
        ))}
      </div>
    </section>
  );
}

/* ===================================================================
   Studio: one sentence → a whole campaign
   =================================================================== */
const GOALS = ["More leads", "Book demos", "Sell a product", "Brand awareness", "Bring clients back"];
const GEN_STEPS = ["Reading your brief and your CRM", "Choosing the audience", "Writing the copy for each channel", "Designing the visuals", "Planning the calendar", "Splitting the budget"];
interface Plan { posts: { ch: ChKey; when: string; title: string; text: string; hue: number; kind: string }[]; split: { ch: ChKey; eur: number }[]; expect: { reach: number; leads: number; cpl: number } }
function makePlan(brief: string, chans: ChKey[], budget: number): Plan {
  const topic = brief.trim().replace(/\.$/, "") || "your new offer";
  const short = topic.length > 46 ? `${topic.slice(0, 44)}…` : topic;
  const days = ["Mon 9:00", "Tue 12:30", "Wed 18:00", "Thu 9:00", "Fri 11:00", "Mon 9:00", "Wed 13:00"];
  const lines: Record<ChKey, [string, string, string]> = {
    instagram: ["Carousel · 5 slides", `Behind ${short}`, "Swipe to see how it works in 30 seconds →"],
    facebook: ["Ad · image", `${short}, without the hassle`, "Book a free 20-minute call this week."],
    linkedin: ["Post · document", `Why teams switch: ${short}`, "3 numbers from clients who did it last quarter."],
    google: ["Search ad", `${short} | Free demo`, "Set up in a day. Talk to an expert today."],
    whatsapp: ["Broadcast", "Quick one 👋", `We just launched ${short}. Want the 2-minute video?`],
    email: ["E-mail · 2 steps", `{{first_name}}, ${short}`, "A short note with one clear next step."],
    tiktok: ["Video · 20 s", "POV: your month-end in 5 minutes", "Hook in 2 seconds, demo, call to action."],
    x: ["Thread · 4 posts", `${short} — a thread`, "What we learned building it 🧵"],
  };
  const posts = chans.flatMap((ch, i) => [0, 1].slice(0, ch === "google" || ch === "whatsapp" ? 1 : 2).map((j) => ({
    ch, when: days[(i + j * 3) % days.length], kind: lines[ch][0], title: lines[ch][1], text: lines[ch][2], hue: (i * 47 + j * 90) % 360,
  })));
  const paid = chans.filter((c) => ["instagram", "facebook", "linkedin", "google", "tiktok"].includes(c));
  const w: Record<string, number> = { linkedin: 3, google: 3, instagram: 2, facebook: 2, tiktok: 1 };
  const sum = paid.reduce((a, c) => a + (w[c] ?? 1), 0) || 1;
  const split = paid.map((ch) => ({ ch, eur: Math.round((budget * (w[ch] ?? 1)) / sum) }));
  return { posts, split, expect: { reach: Math.round(budget * 38 + chans.length * 900), leads: Math.max(3, Math.round(budget / 42)), cpl: Math.round(42 - chans.length) } };
}

export function StudioTab({ toast }: { toast?: (s: string) => void }) {
  const [brief, setBrief] = useState("");
  const [goal, setGoal] = useState(GOALS[0]);
  const [chans, setChans] = useState<ChKey[]>(["linkedin", "instagram", "google", "email"]);
  const [budget, setBudget] = useState(1200);
  const [weeks, setWeeks] = useState(2);
  const [gen, setGen] = useState<number | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [launched, setLaunched] = useState(false);
  const [agents, setAgents] = useState({ cm: true, design: true, copy: true, ads: false });
  const run = () => {
    if (!chans.length) return;
    setPlan(null); setLaunched(false); setGen(0);
    GEN_STEPS.forEach((_, i) => window.setTimeout(() => setGen(i + 1), 420 * (i + 1)));
    window.setTimeout(() => { setGen(null); setPlan(makePlan(brief || "our month-end close service for finance teams", chans, budget)); }, 420 * (GEN_STEPS.length + 1));
  };
  const IDEAS = ["Fill 10 demo slots for our reporting tool before Christmas", "Launch our new consulting package to CFOs in Madrid", "Win back clients who haven't bought in 6 months"];
  return (
    <div className="ml">
      <Preview what="Studio" />
      <div className="ml-studio">
        <section className="ml-brief">
          <div className="ml-brief-h"><span className="ml-orb"><Ico d={I.spark} s={18} /></span><div><b>What do you want to achieve?</b><small>One sentence is enough — we write, design, schedule and launch it everywhere.</small></div></div>
          <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={3}
            placeholder="e.g. Get 15 CFOs in Madrid to book a demo of our month-end close service this month" />
          <div className="ml-ideas">{IDEAS.map((x) => <button key={x} type="button" onClick={() => setBrief(x)}><Ico d={I.wand} s={13} />{x}</button>)}</div>
          <div className="ml-opts">
            <div className="ml-opt"><span>Goal</span><div className="ml-pills">{GOALS.map((g) => <button key={g} type="button" className={goal === g ? "is-on" : ""} onClick={() => setGoal(g)}>{g}</button>)}</div></div>
            <div className="ml-opt"><span>Channels</span>
              <div className="ml-pills is-ch">{ALL.map((k) => {
                const on = chans.includes(k);
                return <button key={k} type="button" className={on ? "is-on" : ""} style={{ ["--cc" as string]: CH[k].color }} onClick={() => setChans(on ? chans.filter((x) => x !== k) : [...chans, k])}><ChDot k={k} s={20} />{CH[k].label}</button>;
              })}</div>
            </div>
            <div className="ml-opt is-row">
              <label><span>Ad budget</span><b>{eur(budget)}</b><input type="range" min={0} max={5000} step={100} value={budget} onChange={(e) => setBudget(Number(e.target.value))} /></label>
              <label><span>Runs for</span><b>{weeks} week{weeks === 1 ? "" : "s"}</b><input type="range" min={1} max={8} value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} /></label>
            </div>
          </div>
          <button type="button" className="ml-go" disabled={gen !== null || !chans.length} onClick={run}><Ico d={I.spark} s={17} />{gen !== null ? "Creating your campaign…" : plan ? "Create it again" : "Create the campaign"}</button>
        </section>

        <aside className="ml-agents">
          <b className="ml-h">Your marketing team</b>
          <small className="ml-sub">Agents that keep it going after launch</small>
          {([["cm", I.comment, "Community manager", "Answers comments & DMs, sends hot leads to Orbit", "34 replies today"], ["design", I.brush, "Designer", "Visuals, carousels and short videos in your brand", "12 visuals this week"], ["copy", I.pen, "Copywriter", "Posts, ads and e-mails in your tone", "18 texts this week"], ["ads", I.chart, "Ads optimiser", "Moves budget to what works, pauses what doesn't", "Off"]] as const).map(([k, ic, t, sub, st]) => {
            const on = agents[k];
            return (
              <div key={k} className={`ml-agent ${on ? "is-on" : ""}`}>
                <i><Ico d={ic} s={16} /></i>
                <span><b>{t}</b><em>{sub}</em><small>{on ? (k === "ads" ? "Watching 4 campaigns" : st) : "Paused"}</small></span>
                <button type="button" className={`ml-switch ${on ? "is-on" : ""}`} role="switch" aria-checked={on} aria-label={t} onClick={() => setAgents({ ...agents, [k]: !on })}><s /></button>
              </div>
            );
          })}
        </aside>
      </div>

      {gen !== null && (
        <section className="ml-gen">
          {GEN_STEPS.map((s, i) => (
            <div key={s} className={`ml-gen-step ${i < gen ? "is-done" : i === gen ? "is-on" : ""}`}><i>{i < gen ? <Ico d={I.check} s={12} /> : null}</i>{s}</div>
          ))}
        </section>
      )}

      {plan && (
        <section className="ml-plan">
          <header className="ml-plan-h">
            <div><b>{brief.trim() || "Month-end close for finance teams"}</b><small>{goal} · {chans.length} channels · {plan.posts.length} pieces · {weeks} week{weeks === 1 ? "" : "s"} · {eur(budget)} ads</small></div>
            <div className="ml-expect">
              <span><em>Reach</em><b>~{fmt(plan.expect.reach)}</b></span>
              <span><em>Leads</em><b>~{plan.expect.leads}</b></span>
              <span><em>Cost / lead</em><b>~{eur(plan.expect.cpl)}</b></span>
            </div>
            <button type="button" className={`ml-go is-launch ${launched ? "is-done" : ""}`} onClick={() => { setLaunched(true); toast?.("Campaign scheduled on every channel (preview — nothing was published)"); }}>
              <Ico d={launched ? I.check : I.rocket} s={16} />{launched ? "Scheduled" : "Launch everything"}
            </button>
          </header>
          <div className="ml-posts">
            {plan.posts.map((p, i) => (
              <article key={i} className="ml-post" style={{ ["--cc" as string]: CH[p.ch].color, ["--i" as string]: i, ["--h" as string]: p.hue }}>
                <header><ChDot k={p.ch} s={22} /><span><b>{CH[p.ch].label}</b><em>{p.kind}</em></span><small>{p.when}</small></header>
                <div className="ml-art"><b>{p.title}</b><i /><i /><i /></div>
                <p>{p.text}</p>
                <footer><button type="button"><Ico d={I.pen} s={13} />Edit</button><button type="button"><Ico d={I.wand} s={13} />Another version</button></footer>
              </article>
            ))}
          </div>
          {plan.split.length > 0 && (
            <div className="ml-split">
              <b className="ml-h">Budget split</b>
              <div className="ml-split-bar">{plan.split.map((s) => <i key={s.ch} style={{ flex: s.eur, background: CH[s.ch].color }} title={`${CH[s.ch].label}: ${eur(s.eur)}`} />)}</div>
              <div className="ml-split-legend">{plan.split.map((s) => <span key={s.ch}><ChDot k={s.ch} s={18} />{CH[s.ch].label}<b>{eur(s.eur)}</b></span>)}</div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/* ===================================================================
   Ads: pay the platforms from here
   =================================================================== */
const ADS = [
  { ch: "linkedin" as ChKey, name: "CFO demo — Madrid", budget: 600, spent: 412, leads: 14, status: "live" },
  { ch: "google" as ChKey, name: "Month-end close — search", budget: 900, spent: 655, leads: 21, status: "live" },
  { ch: "instagram" as ChKey, name: "Reporting carousel", budget: 300, spent: 300, leads: 6, status: "done" },
  { ch: "facebook" as ChKey, name: "Retargeting — site visitors", budget: 250, spent: 96, leads: 3, status: "paused" },
];
export function AdsTab({ toast }: { toast?: (s: string) => void }) {
  const [ads, setAds] = useState(ADS);
  const [linked, setLinked] = useState<Record<string, boolean>>({ facebook: true, instagram: true, google: true, linkedin: true, tiktok: false });
  const spent = ads.reduce((a, x) => a + x.spent, 0);
  const leads = ads.reduce((a, x) => a + x.leads, 0);
  return (
    <div className="ml">
      <Preview what="Ads" />
      <div className="ml-ads-top">
        <section className="ml-wallet">
          <span className="ml-wallet-k">Ads wallet</span>
          <b>{eur(1840)}</b>
          <small>left to spend · paid to Meta, Google, LinkedIn and TikTok from here</small>
          <div className="ml-wallet-card"><Ico d={I.card} s={16} />Company card ···· 4417<em>Charged when the wallet runs low</em></div>
          <div className="ml-wallet-acts"><button type="button" onClick={() => toast?.("Top-ups come with payments (preview)")}><Ico d={I.plus} s={14} />Top up</button><button type="button" className="is-ghost">Invoices</button></div>
        </section>
        <section className="ml-kpis">
          {([["Spent this month", eur(spent), I.euro], ["Leads from ads", String(leads), I.user], ["Cost per lead", eur(Math.round(spent / Math.max(1, leads))), I.target], ["Return on ads", "4.2×", I.chart]] as const).map(([k, v, ic], i) => (
            <div key={k} className="ml-kpi" style={{ ["--i" as string]: i }}><i><Ico d={ic} s={16} /></i><em>{k}</em><b>{v}</b></div>
          ))}
        </section>
      </div>

      <b className="ml-h">Ad accounts</b>
      <div className="ml-accounts">
        {(["facebook", "instagram", "google", "linkedin", "tiktok"] as ChKey[]).map((k) => (
          <div key={k} className={`ml-account ${linked[k] ? "is-on" : ""}`} style={{ ["--cc" as string]: CH[k].color }}>
            <ChDot k={k} s={30} />
            <span><b>{CH[k].label}</b><em>{linked[k] ? "Connected · paid from the wallet" : CH[k].kind}</em></span>
            <button type="button" onClick={() => setLinked({ ...linked, [k]: !linked[k] })}>{linked[k] ? "Connected" : "Connect"}</button>
          </div>
        ))}
      </div>

      <b className="ml-h">Running ads</b>
      <div className="ml-table">
        <div className="ml-tr is-head"><span>Ad</span><span>Budget</span><span>Spent</span><span>Leads</span><span>Cost / lead</span><span /></div>
        {ads.map((a, i) => (
          <div key={a.name} className="ml-tr" style={{ ["--i" as string]: i }}>
            <span className="ml-tname"><ChDot k={a.ch} s={24} /><b>{a.name}</b><em className={`is-${a.status}`}>{a.status === "live" ? "Live" : a.status === "paused" ? "Paused" : "Finished"}</em></span>
            <span>{eur(a.budget)}</span>
            <span><i className="ml-meter"><s style={{ width: `${Math.min(100, (a.spent / a.budget) * 100)}%` }} /></i>{eur(a.spent)}</span>
            <span>{a.leads}</span>
            <span>{eur(Math.round(a.spent / Math.max(1, a.leads)))}</span>
            <span>{a.status !== "done" && <button type="button" className="ml-icon" title={a.status === "live" ? "Pause" : "Resume"} onClick={() => setAds(ads.map((x) => (x.name === a.name ? { ...x, status: x.status === "live" ? "paused" : "live" } : x)))}><Ico d={a.status === "live" ? I.pause : I.play} s={14} /></button>}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ===================================================================
   Results: in depth, with advice
   =================================================================== */
const CAMPS = [
  { name: "CFO demo — Madrid", chans: ["linkedin", "email"] as ChKey[], reach: 18400, likes: 612, reposts: 88, comments: 141, dms: 37, demo: 52, leads: 19, spend: 412 },
  { name: "Month-end close", chans: ["google", "instagram", "facebook"] as ChKey[], reach: 42100, likes: 1290, reposts: 64, comments: 203, dms: 58, demo: 96, leads: 33, spend: 951 },
  { name: "Reporting launch", chans: ["instagram", "tiktok", "x"] as ChKey[], reach: 26700, likes: 2140, reposts: 311, comments: 287, dms: 22, demo: 31, leads: 8, spend: 300 },
  { name: "Win-back — 6 months", chans: ["whatsapp", "email"] as ChKey[], reach: 640, likes: 0, reposts: 0, comments: 0, dms: 71, demo: 18, leads: 12, spend: 0 },
];
const ADVICE = [
  { t: "Move €300 from Facebook to LinkedIn", why: "LinkedIn brings leads at €22, Facebook at €68 — for the same audience.", gain: "+9 leads / month", ic: I.euro },
  { t: "Post on Tuesdays at 9:00", why: "Your posts then get 2.3× the comments of Friday afternoons.", gain: "+38% engagement", ic: I.bolt },
  { t: "Use carousels, not single images", why: "On Instagram your carousels get 2.1× the saves and 3× the demo clicks.", gain: "+14 demo clicks", ic: I.layers },
  { t: "Answer DMs within the hour", why: "71% of DMs answered in < 1 h turned into a demo; 18% after a day.", gain: "Turn on the community manager", ic: I.dm },
];
export function ResultsTab({ toast }: { toast?: (s: string) => void }) {
  const t = useMemo(() => CAMPS.reduce((a, c) => ({ reach: a.reach + c.reach, likes: a.likes + c.likes, reposts: a.reposts + c.reposts, comments: a.comments + c.comments, dms: a.dms + c.dms, demo: a.demo + c.demo, leads: a.leads + c.leads, spend: a.spend + c.spend }), { reach: 0, likes: 0, reposts: 0, comments: 0, dms: 0, demo: 0, leads: 0, spend: 0 }), []);
  const funnel = [["Reached", t.reach], ["Engaged", t.likes + t.reposts + t.comments], ["Talked to you", t.dms + t.comments], ["Clicked to demo", t.demo], ["Leads in Orbit", t.leads], ["Won", 9]] as const;
  const [applied, setApplied] = useState<Set<number>>(new Set());
  return (
    <div className="ml">
      <Preview what="Results" />
      <section className="ml-kpis is-6">
        {([["Reach", fmt(t.reach), I.eye], ["Likes", fmt(t.likes), I.heart], ["Reposts", fmt(t.reposts), I.repost], ["Comments", fmt(t.comments), I.comment], ["Direct messages", fmt(t.dms), I.dm], ["Demo clicks", fmt(t.demo), I.click]] as const).map(([k, v, ic], i) => (
          <div key={k} className="ml-kpi" style={{ ["--i" as string]: i }}><i><Ico d={ic} s={16} /></i><em>{k}</em><b>{v}</b></div>
        ))}
      </section>

      <div className="ml-res">
        <section className="ml-funnel">
          <b className="ml-h">From a post to a client</b>
          {funnel.map(([k, v], i) => (
            <div key={k} className="ml-fstep" style={{ ["--w" as string]: `${Math.max(14, 100 - i * 15)}%`, ["--i" as string]: i }}>
              <span><em>{k}</em><b>{fmt(v)}</b></span>
              {i > 0 && <small>{((v / Math.max(1, funnel[i - 1][1])) * 100).toFixed(v / funnel[i - 1][1] < 0.1 ? 1 : 0)}%</small>}
            </div>
          ))}
          <div className="ml-fcost"><span>Spent <b>{eur(t.spend)}</b></span><span>Cost per lead <b>{eur(Math.round(t.spend / Math.max(1, t.leads)))}</b></span><span>Cost per client <b>{eur(Math.round(t.spend / 9))}</b></span></div>
        </section>

        <section className="ml-advice">
          <b className="ml-h"><Ico d={I.spark} s={15} />What to do next</b>
          {ADVICE.map((a, i) => (
            <div key={a.t} className={`ml-tip ${applied.has(i) ? "is-done" : ""}`} style={{ ["--i" as string]: i }}>
              <i><Ico d={a.ic} s={15} /></i>
              <span><b>{a.t}</b><em>{a.why}</em><small>{a.gain}</small></span>
              <button type="button" disabled={applied.has(i)} onClick={() => { setApplied(new Set([...applied, i])); toast?.("Applied (preview)"); }}>{applied.has(i) ? <><Ico d={I.check} s={13} />Done</> : "Apply"}</button>
            </div>
          ))}
        </section>
      </div>

      <b className="ml-h">By campaign</b>
      <div className="ml-table is-res">
        <div className="ml-tr is-head"><span>Campaign</span><span>Reach</span><span>Likes</span><span>Reposts</span><span>Comments</span><span>DMs</span><span>Demo clicks</span><span>Leads</span><span>€ / lead</span></div>
        {CAMPS.map((c, i) => (
          <div key={c.name} className="ml-tr" style={{ ["--i" as string]: i }}>
            <span className="ml-tname"><span className="ml-chs">{c.chans.map((k) => <ChDot key={k} k={k} s={22} />)}</span><b>{c.name}</b></span>
            <span>{fmt(c.reach)}</span><span>{fmt(c.likes)}</span><span>{fmt(c.reposts)}</span><span>{fmt(c.comments)}</span><span>{fmt(c.dms)}</span><span>{fmt(c.demo)}</span>
            <span><b>{c.leads}</b></span><span>{c.spend ? eur(Math.round(c.spend / Math.max(1, c.leads))) : "—"}</span>
          </div>
        ))}
      </div>
      <LeadStrip />
    </div>
  );
}

/* ===================================================================
   Website: generate it
   =================================================================== */
const STYLES = [
  { k: "clean", label: "Clean", a: "#0a6f4d", b: "#e9f7f0" },
  { k: "bold", label: "Bold", a: "#111827", b: "#facc15" },
  { k: "warm", label: "Warm", a: "#9a3412", b: "#fff1e6" },
  { k: "tech", label: "Tech", a: "#4338ca", b: "#eef2ff" },
];
export function WebsiteTab({ toast }: { toast?: (s: string) => void }) {
  const [about, setAbout] = useState("Consultancy that closes the month for finance teams in 5 days, with our own reporting software.");
  const [style, setStyle] = useState(STYLES[0]);
  const [pages, setPages] = useState(["Home", "Services", "Products", "About", "Contact"]);
  const [built, setBuilt] = useState(false);
  const [busy, setBusy] = useState(false);
  const all = ["Home", "Services", "Products", "Pricing", "Cases", "Blog", "About", "Contact"];
  const build = () => { setBusy(true); setBuilt(false); window.setTimeout(() => { setBusy(false); setBuilt(true); }, 1600); };
  return (
    <div className="ml">
      <Preview what="Website" />
      <div className="ml-web">
        <section className="ml-brief is-web">
          <div className="ml-brief-h"><span className="ml-orb"><Ico d={I.globe} s={18} /></span><div><b>Your website, generated</b><small>From what you sell (Products &amp; Services) and a few lines about you. Every form sends leads to Orbit.</small></div></div>
          <textarea value={about} onChange={(e) => setAbout(e.target.value)} rows={3} />
          <div className="ml-opt"><span>Style</span>
            <div className="ml-styles">{STYLES.map((s) => (
              <button key={s.k} type="button" className={style.k === s.k ? "is-on" : ""} onClick={() => setStyle(s)}><i style={{ background: `linear-gradient(135deg, ${s.a} 50%, ${s.b} 50%)` }} />{s.label}</button>
            ))}</div>
          </div>
          <div className="ml-opt"><span>Pages</span>
            <div className="ml-pills">{all.map((p) => <button key={p} type="button" className={pages.includes(p) ? "is-on" : ""} onClick={() => setPages(pages.includes(p) ? pages.filter((x) => x !== p) : [...pages, p])}>{p}</button>)}</div>
          </div>
          <button type="button" className="ml-go" disabled={busy} onClick={build}><Ico d={I.spark} s={17} />{busy ? "Building your site…" : built ? "Build it again" : "Build my website"}</button>
          {built && <div className="ml-domain"><Ico d={I.link} s={15} /><span>brazo<b>.next.site</b></span><button type="button" onClick={() => toast?.("Publishing comes with hosting (preview)")}>Publish</button><button type="button" className="is-ghost">Use my domain</button></div>}
        </section>
        <section className={`ml-browser ${busy ? "is-busy" : ""}`} style={{ ["--sa" as string]: style.a, ["--sb" as string]: style.b }}>
          <div className="ml-browser-bar"><i /><i /><i /><span>{built ? "brazo.next.site" : "your-site"}</span></div>
          <div className="ml-site">
            <nav><b>Brazo</b>{pages.filter((p) => p !== "Home").slice(0, 5).map((p) => <span key={p}>{p}</span>)}<em>Book a demo</em></nav>
            <div className="ml-site-hero"><div><h3>{about.split(/[.,]/)[0] || "Your company"}</h3><p>{about}</p><em>Book a free demo</em></div><i /></div>
            <div className="ml-site-cards">{["Consolidation", "Reporting", "Implementation"].map((x) => <div key={x}><i /><b>{x}</b><span /><span /></div>)}</div>
            <div className="ml-site-form"><b>Talk to us</b><span /><span /><em>Send → lands in Orbit as a lead</em></div>
          </div>
        </section>
      </div>
    </div>
  );
}

/** A tab label with a small "new" dot. */
export const NewTag = ({ children }: { children: ReactNode }) => <>{children}<i className="ml-new" /></>;
