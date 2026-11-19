/**
 * BASE · Growth › Marketing › Ads — a mockup (sample figures, nothing is charged, nothing is saved).
 * One wallet pays every ad platform (Google Ads, LinkedIn Ads, Meta, TikTok): add funds to it, then
 * decide how much of it each ad campaign gets — or take money back. Lives in the Marketing page's
 * tab bar like the other tabs; its tools go into the page bar (`bar`).
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BRANDS } from "./brandIcons";
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
type Camp = { id: string; pf: Pf; name: string; goal: Goal; status: Status; budget: number; spent: number; daily: number; clicks: number; leads: number };

const SEED: Camp[] = [
  { id: "a1", pf: "linkedin", name: "CFO webinar — year-end close", goal: "Leads", status: "live", budget: 1200, spent: 784, daily: 45, clicks: 412, leads: 23 },
  { id: "a2", pf: "gads", name: "Power BI consulting — search", goal: "Leads", status: "live", budget: 900, spent: 512, daily: 30, clicks: 1290, leads: 31 },
  { id: "a3", pf: "meta", name: "Customer stories — retargeting", goal: "Website visits", status: "live", budget: 450, spent: 301, daily: 15, clicks: 2210, leads: 9 },
  { id: "a4", pf: "gads", name: "Brand — Brazo", goal: "Website visits", status: "paused", budget: 200, spent: 188, daily: 8, clicks: 640, leads: 4 },
  { id: "a5", pf: "linkedin", name: "Month-end in 3 days — video", goal: "Awareness", status: "draft", budget: 0, spent: 0, daily: 25, clicks: 0, leads: 0 },
];

const eur = (n: number) => `${Math.round(n).toLocaleString("en-GB")} €`;
const ST: Record<Status, string> = { live: "Live", paused: "Paused", draft: "Draft" };

/* ---------- icons ---------- */
const svg = (d: ReactNode, s = 18) => <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>;
export const ADS_ICO = svg(<><path d="M3 11l15-6v14L3 13z" /><path d="M7 13v5a2 2 0 0 0 4 0v-3.5" /><path d="M21 9v4" /></>, 16);
const I = {
  wallet: svg(<><path d="M3 7a2 2 0 0 1 2-2h12v4" /><path d="M3 7v10a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2z" /><circle cx="16" cy="14" r="1.2" fill="currentColor" /></>),
  plus: svg(<path d="M12 5v14M5 12h14" />, 16),
  minus: svg(<path d="M5 12h14" />, 16),
  x: svg(<path d="M18 6 6 18M6 6l12 12" />, 16),
  play: svg(<path d="M7 5l12 7-12 7z" />, 14),
  pause: svg(<><path d="M8 5v14M16 5v14" /></>, 14),
  arrow: svg(<path d="M5 12h14M13 6l6 6-6 6" />, 15),
  card: svg(<><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M3 10h18" /></>, 16),
  bolt: svg(<path d="M13 2 4 14h7l-1 8 9-12h-7z" />, 15),
  spend: svg(<><path d="M4 19h16" /><path d="M7 15l4-4 3 3 5-6" /></>),
  leads: svg(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M17 8v6M14 11h6" /></>),
  info: svg(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>, 14),
};
function Logo({ pf, s = 20 }: { pf: Pf; s?: number }) {
  const b = BRANDS[pf];
  return <svg className="ads-logo" viewBox="0 0 24 24" width={s} height={s} role="img" aria-label={PF[pf].name} style={{ color: b?.hex ?? PF[pf].color } as CSSProperties}><path d={b?.path ?? ""} fill="currentColor" /></svg>;
}

/* ---------- the tab ---------- */
export default function AdsTab({ bar, toast }: { bar: HTMLElement | null; toast: (s: string) => void }) {
  const [wallet, setWallet] = useState(2480);
  const [auto, setAuto] = useState(true);
  const [camps, setCamps] = useState<Camp[]>(SEED);
  const [linked, setLinked] = useState<Set<Pf>>(new Set<Pf>(["gads", "linkedin", "meta"]));
  const [pf, setPf] = useState<Pf | "all">("all");
  const [panel, setPanel] = useState<null | { k: "funds" } | { k: "move"; id: string } | { k: "new"; pf?: Pf }>(null);

  const active = camps.filter((c) => c.status !== "draft");
  const assigned = active.reduce((s, c) => s + c.budget, 0);
  const spent = camps.reduce((s, c) => s + c.spent, 0);
  const leads = camps.reduce((s, c) => s + c.leads, 0);
  const perDay = camps.filter((c) => c.status === "live").reduce((s, c) => s + c.daily, 0);
  const shown = camps.filter((c) => pf === "all" || c.pf === pf);
  const byPf = (p: Pf) => { const cs = camps.filter((c) => c.pf === p); return { n: cs.length, live: cs.filter((c) => c.status === "live").length, budget: cs.reduce((s, c) => s + c.budget, 0), spent: cs.reduce((s, c) => s + c.spent, 0) }; };

  const move = (id: string, amount: number) => {
    // + from the wallet to the campaign; − back to the wallet
    setCamps((xs) => xs.map((c) => (c.id === id ? { ...c, budget: Math.max(c.spent, c.budget + amount) } : c)));
    setWallet((w) => w - amount);
    const c = camps.find((x) => x.id === id);
    toast(amount >= 0 ? `${eur(amount)} sent to "${c?.name}"` : `${eur(-amount)} back in the wallet`);
  };

  const tools = (
    <div className="em-tools ads-tools">
      <span className="ads-preview" title="Sample figures: connect your ad accounts to see real ones. Nothing is charged.">{I.info}Preview</span>
      <div className="ads-pfs" role="group" aria-label="Platform">
        <button className={`is-all ${pf === "all" ? "is-on" : ""}`} onClick={() => setPf("all")}>All</button>
        {PF_KEYS.map((k) => (
          <button key={k} className={`${pf === k ? "is-on" : ""} ${pf !== "all" && pf !== k ? "is-dim" : ""}`} style={{ ["--n" as string]: BRANDS[k]?.hex ?? PF[k].color } as CSSProperties}
            onClick={() => setPf(pf === k ? "all" : k)} title={PF[k].name} aria-label={PF[k].name} aria-pressed={pf === k}><Logo pf={k} s={18} /></button>
        ))}
      </div>
      <button type="button" className="ads-funds-b" onClick={() => setPanel({ k: "funds" })}>{I.plus}Add funds</button>
      <button type="button" className="em-new" onClick={() => setPanel({ k: "new", pf: pf === "all" ? undefined : pf })}>{I.plus}<span>New ad campaign</span></button>
    </div>
  );

  return (
    <div className="mkx-page ads">
      {bar ? createPortal(tools, bar) : null}

      {/* the money: the wallet and where it goes */}
      <section className="ads-top">
        <div className="ads-wallet">
          <header><i>{I.wallet}</i><span>Wallet</span><span className="ads-grow" />
            <button className={`ads-auto ${auto ? "is-on" : ""}`} onClick={() => { setAuto(!auto); toast(auto ? "Auto top-up off" : "Auto top-up on: 500 € when it drops below 200 €"); }} aria-pressed={auto}>
              <i className="ads-sw" />Auto top-up
            </button>
          </header>
          <b className="ads-wallet-v">{eur(wallet)}</b>
          <p>{perDay ? <>Covers about <em>{Math.max(0, Math.floor(wallet / perDay))} days</em> at today's {eur(perDay)}/day</> : "Nothing is running"}{auto ? " · tops up 500 € below 200 €" : ""}</p>
          <div className="ads-wallet-a">
            <button className="ads-btn is-lime" onClick={() => setPanel({ k: "funds" })}>{I.plus}Add funds</button>
            <button className="ads-btn is-ghost" onClick={() => { const c = camps.find((x) => x.status === "live"); if (c) setPanel({ k: "move", id: c.id }); }}>{I.arrow}Send to a campaign</button>
          </div>
        </div>
        <div className="ads-fig is-lime">
          <header><i>{I.spend}</i><span>Given to campaigns</span></header>
          <b>{eur(assigned)}</b>
          <span className="ads-bar"><i style={{ width: `${assigned ? Math.min(100, (spent / assigned) * 100) : 0}%` }} /></span>
          <p><em>{eur(spent)}</em> spent · <em>{eur(Math.max(0, assigned - spent))}</em> left</p>
        </div>
        <div className="ads-fig">
          <header><i>{I.leads}</i><span>Leads from ads</span></header>
          <b>{leads}</b>
          <p>this month · <em>{leads ? eur(spent / leads) : "—"}</em> per lead</p>
        </div>
        <div className="ads-fig">
          <header><i>{I.bolt}</i><span>Running</span></header>
          <b>{camps.filter((c) => c.status === "live").length}<small> of {camps.length}</small></b>
          <p>campaigns · <em>{eur(perDay)}</em> a day</p>
        </div>
      </section>

      {/* each platform: connected or not, what it got, what it spent */}
      <section className="ads-pf-row">
        {PF_KEYS.map((k) => {
          const s = byPf(k), on = linked.has(k);
          return (
            <article key={k} className={`ads-pf ${on ? "" : "is-off"} ${pf === k ? "is-sel" : ""}`} style={{ ["--n" as string]: BRANDS[k]?.hex ?? PF[k].color } as CSSProperties}>
              <span className="ads-pf-ico"><Logo pf={k} s={22} /></span>
              <div className="ads-pf-t"><b>{PF[k].name}</b><em>{on ? (s.n ? `${s.live} live · ${s.n} campaign${s.n === 1 ? "" : "s"}` : "No campaigns yet") : PF[k].sub}</em></div>
              {on ? (
                <div className="ads-pf-m">
                  <span><b>{eur(s.budget)}</b><em>given</em></span>
                  <span className="ads-bar is-sm"><i style={{ width: `${s.budget ? Math.min(100, (s.spent / s.budget) * 100) : 0}%` }} /></span>
                  <span><b>{eur(s.spent)}</b><em>spent</em></span>
                </div>
              ) : (
                <button className="ads-btn is-ghost is-sm" onClick={() => { setLinked((x) => new Set([...x, k])); toast(`${PF[k].name} connected (preview)`); }}>Connect</button>
              )}
            </article>
          );
        })}
      </section>

      {/* the campaigns: how much each one gets from the wallet */}
      <section className="ads-list">
        <div className="ads-th"><span>Campaign</span><span>Status</span><span>Budget from the wallet</span><span>Spent</span><span>Clicks</span><span>Leads</span><span>Per lead</span><span /></div>
        <div className="ads-rows">
          {shown.map((c, i) => {
            const pct = c.budget ? Math.min(100, (c.spent / c.budget) * 100) : 0;
            const low = c.status === "live" && c.budget - c.spent < c.daily * 5;
            return (
              <div key={c.id} className={`ads-tr is-${c.status}`} style={{ ["--i" as string]: i } as CSSProperties}>
                <span className="ads-c"><span className="ads-c-ico"><Logo pf={c.pf} s={18} /></span><span><b>{c.name}</b><em>{PF[c.pf].name} · {c.goal} · {eur(c.daily)}/day</em></span></span>
                <span><i className={`ads-st is-${c.status}`}>{ST[c.status]}</i></span>
                <span className="ads-b">
                  <span className="ads-b-v"><b>{eur(c.budget)}</b>{low && <em className="ads-low">running low</em>}</span>
                  <span className="ads-bar is-sm"><i style={{ width: `${pct}%` }} /></span>
                </span>
                <span className="ads-n">{eur(c.spent)}</span>
                <span className="ads-n">{c.clicks.toLocaleString("en-GB")}</span>
                <span className="ads-n">{c.leads || "—"}</span>
                <span className="ads-n">{c.leads ? eur(c.spent / c.leads) : "—"}</span>
                <span className="ads-acts">
                  <button className="ads-btn is-lime is-sm" onClick={() => setPanel({ k: "move", id: c.id })}>{I.wallet}Budget</button>
                  {c.status !== "draft" && (
                    <button className="ads-ico" title={c.status === "live" ? "Pause" : "Resume"} aria-label={c.status === "live" ? "Pause" : "Resume"}
                      onClick={() => { setCamps((xs) => xs.map((y) => (y.id === c.id ? { ...y, status: y.status === "live" ? "paused" : "live" } : y))); toast(c.status === "live" ? "Paused" : "Running again"); }}>
                      {c.status === "live" ? I.pause : I.play}
                    </button>
                  )}
                </span>
              </div>
            );
          })}
          {!shown.length && <p className="ads-empty">No campaigns on {pf === "all" ? "any platform" : PF[pf].name} yet.</p>}
        </div>
      </section>

      {panel?.k === "funds" && <FundsPanel wallet={wallet} onClose={() => setPanel(null)} onAdd={(v) => { setWallet((w) => w + v); setPanel(null); toast(`${eur(v)} added to the wallet (preview — nothing charged)`); }} />}
      {panel?.k === "move" && (() => { const c = camps.find((x) => x.id === panel.id); return c ? <MovePanel camps={camps} c={c} wallet={wallet} onPick={(id) => setPanel({ k: "move", id })} onClose={() => setPanel(null)} onMove={(v) => { move(c.id, v); setPanel(null); }} /> : null; })()}
      {panel?.k === "new" && <NewPanel pf0={panel.pf} linked={linked} wallet={wallet} onClose={() => setPanel(null)}
        onCreate={(c) => { setCamps((xs) => [c, ...xs]); if (c.budget) setWallet((w) => w - c.budget); setPanel(null); toast(`"${c.name}" created — ${c.status === "live" ? "running" : "saved as a draft"}`); }} />}
    </div>
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
    <Side title="Add funds" sub="One wallet pays all your ad platforms. You choose how much each campaign gets." onClose={onClose}
      foot={<><span className="ads-grow" /><button className="ads-btn is-ghost" onClick={onClose}>Cancel</button><button className="ads-btn is-pine" disabled={!v} onClick={() => onAdd(v)}>{I.plus}Add {eur(v)}</button></>}>
      <div className="ads-kv"><span>In the wallet now</span><b>{eur(wallet)}</b></div>
      <Amount value={v} onChange={setV} chips={[100, 250, 500, 1000, 2500]} />
      <div className="ads-kv is-after"><span>After</span><b>{eur(wallet + v)}</b></div>
      <div className="ads-pay"><i>{I.card}</i><span><b>Visa ending 4242</b><em>Company card · change in Settings › Billing</em></span><span className="ads-tag">Preview</span></div>
      <p className="ads-note">{I.info}Preview — nothing is charged. Unused money stays in the wallet and can be withdrawn.</p>
    </Side>
  );
}
function MovePanel({ camps, c, wallet, onPick, onClose, onMove }: { camps: Camp[]; c: Camp; wallet: number; onPick: (id: string) => void; onClose: () => void; onMove: (v: number) => void }) {
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
        <button className="ads-btn is-pine" disabled={!amt} onClick={() => onMove(dir === "in" ? amt : -amt)}>{dir === "in" ? <>{I.arrow}Send {eur(amt)}</> : <>{I.wallet}Take back {eur(amt)}</>}</button></>}>
      <div className="ads-pick">
        {pickable.map((x) => (
          <button key={x.id} className={x.id === c.id ? "is-on" : ""} onClick={() => onPick(x.id)}>
            <Logo pf={x.pf} s={16} /><span><b>{x.name}</b><em>{eur(x.budget)} · {eur(x.spent)} spent</em></span>
          </button>
        ))}
      </div>
      <div className="ads-dir" role="tablist">
        <button className={dir === "in" ? "is-on" : ""} onClick={() => setDir("in")}>Wallet → campaign</button>
        <button className={dir === "out" ? "is-on" : ""} onClick={() => setDir("out")} disabled={!canBack}>Campaign → wallet</button>
      </div>
      <Amount value={amt} onChange={setV} chips={dir === "in" ? [50, 100, 250, 500, 1000] : [50, 100, 250]} max={max} />
      <div className="ads-flow">
        <div><span>Wallet</span><b>{eur(wallet)}</b><em>→ {eur(wallet + (dir === "in" ? -amt : amt))}</em></div>
        <i>{I.arrow}</i>
        <div><span>{c.name}</span><b>{eur(c.budget)}</b><em>→ {eur(after)}</em></div>
      </div>
      {days != null && c.status !== "draft" && <p className="ads-note">{I.info}At {eur(c.daily)}/day that's about <b>{Math.max(0, days)} days</b> of ads left.</p>}
    </Side>
  );
}
function NewPanel({ pf0, linked, wallet, onClose, onCreate }: { pf0?: Pf; linked: Set<Pf>; wallet: number; onClose: () => void; onCreate: (c: Camp) => void }) {
  const [pf, setPf] = useState<Pf>(pf0 ?? "linkedin");
  const [name, setName] = useState("");
  const [goal, setGoal] = useState<Goal>("Leads");
  const [daily, setDaily] = useState(25);
  const [budget, setBudget] = useState(Math.min(300, wallet));
  const ok = name.trim() && linked.has(pf);
  const make = (status: Status) => onCreate({ id: `n${Date.now()}`, pf, name: name.trim(), goal, status, budget: status === "draft" ? 0 : budget, spent: 0, daily, clicks: 0, leads: 0 });
  return (
    <Side title="New ad campaign" sub="Pick the platform, what you want from it and how much it gets from the wallet." onClose={onClose}
      foot={<><span className="ads-grow" /><button className="ads-btn is-ghost" disabled={!ok} onClick={() => make("draft")}>Save as draft</button><button className="ads-btn is-pine" disabled={!ok || !budget} onClick={() => make("live")}>{I.play}Launch with {eur(budget)}</button></>}>
      <span className="ads-k">Platform</span>
      <div className="ads-pf-pick">
        {PF_KEYS.map((k) => (
          <button key={k} className={`${pf === k ? "is-on" : ""} ${linked.has(k) ? "" : "is-off"}`} style={{ ["--n" as string]: BRANDS[k]?.hex ?? PF[k].color } as CSSProperties} onClick={() => setPf(k)}>
            <Logo pf={k} s={22} /><b>{PF[k].name}</b><em>{linked.has(k) ? "Connected" : "Not connected"}</em>
          </button>
        ))}
      </div>
      <label className="ads-fld"><span className="ads-k">Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Year-end close — CFOs in Spain" /></label>
      <span className="ads-k">What you want</span>
      <div className="ads-dir">{(["Leads", "Website visits", "Awareness"] as Goal[]).map((g) => <button key={g} className={goal === g ? "is-on" : ""} onClick={() => setGoal(g)}>{g}</button>)}</div>
      <span className="ads-k">A day, at most</span>
      <Amount value={daily} onChange={setDaily} chips={[10, 25, 50, 100]} />
      <span className="ads-k">From the wallet to start</span>
      <Amount value={budget} onChange={setBudget} chips={[100, 250, 500, 1000]} max={wallet} />
      <p className="ads-note">{I.info}{budget && daily ? <>About <b>{Math.floor(budget / daily)} days</b> of ads · {eur(wallet - budget)} stays in the wallet.</> : "Saved as a draft, nothing is spent."}</p>
    </Side>
  );
}
