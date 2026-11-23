import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import "./LoginStory.css";

/* ---------------------------------------------------------------------------
   The sign-in page's story panel: the whole Next process in seven short 2D
   scenes, each told with the product's own cards — the inbox and the new
   contact, the pipeline, the contract being signed, the trip to the kick-off,
   the plan, the invoice getting paid, the renewal. One scene folds away while
   the next builds itself up, card by card; the sky behind changes colour.
   Plain HTML + CSS (+ a few SVG strokes). Decorative: aria-hidden.
   --------------------------------------------------------------------------- */

export const STORY_STEPS: { k: string; line: string }[] = [
  { k: "Contact", line: "Every e-mail, call and meeting lands in one place." },
  { k: "Deal", line: "Deals move through the pipeline — you see every step." },
  { k: "Contract", line: "Signed — and the project is already set up." },
  { k: "Kick-off", line: "The team, the trips and day one, on one calendar." },
  { k: "Project", line: "Hours, milestones and margin, live while the work happens." },
  { k: "Billing", line: "The invoice goes out; the money comes home." },
  { k: "Renewal", line: "Happy clients grow — and you see it coming." },
];
const STEP_MS = 6400;
const W = 640, H = 460;

const v = (o: Record<string, string | number>) => o as CSSProperties;
/** an element of a scene: its place on the 640 × 460 stage and its turn in the build-up */
function El({ i, x, y, w, h, cls = "", children }: { i: number; x: number; y: number; w?: number; h?: number; cls?: string; children: ReactNode }) {
  return <div className={`lx-el ${cls}`} style={v({ "--i": i, left: x, top: y, ...(w ? { width: w } : {}), ...(h ? { height: h } : {}) })}>{children}</div>;
}
function Av({ t, c, s = 28 }: { t: string; c: number; s?: number }) {
  return <span className={`lx-av is-c${c}`} style={{ width: s, height: s, fontSize: s * 0.38 }}>{t}</span>;
}
const Ico = ({ d, s = 16 }: { d: ReactNode; s?: number }) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{d}</svg>
);
const I = {
  mail: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M4 7l8 6 8-6" /></>,
  phone: <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" />,
  cal: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  building: <><path d="M4 21V5l8-3v19M12 9h8v12" /><path d="M7 8h2M7 12h2M7 16h2M15 13h2M15 17h2" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  doc: <><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  plane: <path d="M2.5 13.5l19-6-3.5 8-6-1.5-3 4.5-1-5.5z" />,
  jet: <path fill="currentColor" stroke="none" d="M22 12c0-.8-.7-1.4-1.5-1.4H15L10 3H8l2.5 7.6H6L4.3 8H3l1 4-1 4h1.3L6 13.4h4.5L8 21h2l5-7.6h5.5c.8 0 1.5-.6 1.5-1.4z" />,
  bank: <><path d="M3 10l9-6 9 6" /><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 21h18" /></>,
  loop: <><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4.5V11h-6.5" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  up: <path d="M4 17l6-6 4 4 6-7M15 8h5v5" />,
};
const Lines = ({ n, w = [100, 86, 92, 64] }: { n: number; w?: number[] }) => (
  <span className="lx-lines">{Array.from({ length: n }, (_, k) => <i key={k} style={{ width: `${w[k % w.length]}%` }} />)}</span>
);

/* ---------------- the seven scenes ---------------- */
const SCENES: ReactNode[] = [
  /* 0 · Contact: the e-mails arrive, one becomes a contact, a call gets booked */
  <>
    <El i={0} x={18} y={34} w={300} cls="lx-card">
      <div className="lx-head"><span className="lx-k">Inbox</span><span className="lx-badge">3 new</span></div>
      {[["LF", 1, "Lucía Ferrer", "Your finance outsourcing proposal"], ["JM", 2, "Jonas Meyer", "Re: quarterly close"], ["AK", 3, "Amira Khan", "Intro — Halden & Moss"]].map(([t, c, n, s], k) => (
        <div key={k} className={`lx-mail ${k === 0 ? "is-hot" : ""}`} style={v({ "--j": k })}>
          <Av t={t as string} c={c as number} />
          <span className="lx-mail-txt"><b>{n}</b><em>{s}</em></span>
          {k === 0 && <span className="lx-tag">New</span>}
        </div>
      ))}
    </El>
    <svg className="lx-el lx-wire" style={v({ "--i": 15, left: 300, top: 70, width: 80, height: 90 })} viewBox="0 0 80 90"><path d="M2 14 C 46 14, 34 78, 78 78" pathLength={1} /></svg>
    <El i={17} x={366} y={96} w={256} cls="lx-card lx-contact">
      <div className="lx-contact-top"><Av t="LF" c={1} s={52} /><span><b>Lucía Ferrer</b><em>CFO · Halden &amp; Moss</em></span></div>
      <div className="lx-chips"><span><Ico d={I.mail} s={13} />E-mail</span><span><Ico d={I.phone} s={13} />Call</span><span><Ico d={I.cal} s={13} />Meeting</span></div>
      <div className="lx-ok"><Ico d={I.check} s={13} />Added to contacts</div>
    </El>
    <El i={27} x={30} y={318} w={276} cls="lx-glass lx-toast">
      <span className="lx-ico is-lime"><Ico d={I.cal} /></span>
      <span><b>Intro call booked</b><em>Thursday · 10:00 · Teams</em></span>
    </El>
    <El i={30} x={376} y={322} w={236} cls="lx-glass lx-toast">
      <span className="lx-ico"><Ico d={I.building} /></span>
      <span><b>Halden &amp; Moss</b><em>Amsterdam · 140 people</em></span>
    </El>
  </>,

  /* 1 · Deal: a card moves to Won, the column lights up */
  <>
    <El i={0} x={18} y={26} w={604} h={282} cls="lx-card lx-board">
      {[["Lead", 2, "is-v"], ["Proposal", 2, "is-s"], ["Won", 1, "is-g"]].map(([n, c, k], col) => (
        <div key={col} className={`lx-col ${k}`}>
          <div className="lx-col-head"><i />{n}<span>{col === 2 ? <><em className="lx-n1">1</em><em className="lx-n2">2</em></> : c}</span></div>
        </div>
      ))}
      {[[0, 0, "Northwind", "22,000 €", 2], [0, 1, "Brightline", "9,500 €", 3], [1, 1, "Arcadia", "15,000 €", 4], [2, 0, "Kestrel", "31,000 €", 5]].map(([col, row, n, val, c], k) => (
        <div key={k} className="lx-deal" style={v({ left: 19 + (col as number) * 198, top: 52 + (row as number) * 84, "--j": k })}>
          <span className="lx-deal-top"><Av t={(n as string).slice(0, 2).toUpperCase()} c={c as number} s={24} /><b>{n}</b></span>
          <span className="lx-deal-bot"><em>{val}</em><Lines n={1} w={[46]} /></span>
        </div>
      ))}
      <div className="lx-deal is-mover" style={v({ left: 217, top: 52, "--j": 4 })}>
        <span className="lx-deal-top"><Av t="HM" c={1} s={24} /><b>Halden &amp; Moss</b></span>
        <span className="lx-deal-bot"><em>48,000 €</em><Lines n={1} w={[46]} /></span>
      </div>
      <span className="lx-plus">+ 48,000 €</span>
    </El>
    <El i={6} x={30} y={330} w={280} cls="lx-card lx-kpi">
      <span className="lx-k">Pipeline</span>
      <b className="lx-big">184,000 €</b>
      <svg className="lx-spark" viewBox="0 0 120 34"><path d="M2 30 L20 24 L36 27 L52 16 L70 19 L88 9 L118 4" pathLength={1} /></svg>
    </El>
    <El i={8} x={330} y={330} w={280} cls="lx-glass lx-ringcard">
      <svg className="lx-ring" viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" className="is-track" /><circle cx="22" cy="22" r="18" className="is-val" pathLength={100} /></svg>
      <span><em>Win probability</em><b>80%</b></span>
    </El>
  </>,

  /* 2 · Contract: the agreement is signed by both, the project appears */
  <>
    <El i={0} x={46} y={30} w={306} cls="lx-card lx-doc">
      <div className="lx-doc-head"><span className="lx-ico is-soft"><Ico d={I.doc} /></span><span><b>Service agreement</b><em>Halden &amp; Moss · 12 months</em></span></div>
      <Lines n={4} /><div className="lx-gap" /><Lines n={4} w={[100, 94, 88, 52]} />
      <div className="lx-sign">
        <svg viewBox="0 0 200 50"><path d="M6 36c16-26 22 10 36-4s10-18 20-4 16 14 26-4 14 10 22 6 20-14 34-10 18 8 50 4" pathLength={1} /></svg>
        <span>Lucía Ferrer · CFO</span>
      </div>
      <span className="lx-stamp">Signed</span>
    </El>
    <El i={6} x={378} y={52} w={236} cls="lx-card lx-signers">
      <span className="lx-k">Signatures</span>
      <div className="lx-signer is-a"><Av t="LF" c={1} /><span><b>Lucía Ferrer</b><em>Halden &amp; Moss</em></span><i><Ico d={I.check} s={12} /></i></div>
      <div className="lx-signer is-b"><Av t="IB" c={4} /><span><b>You</b><em>Next Finance</em></span><i><Ico d={I.check} s={12} /></i></div>
    </El>
    <El i={30} x={378} y={250} w={250} cls="lx-glass lx-toast">
      <span className="lx-ico is-lime"><Ico d={I.folder} /></span>
      <span><b>Project created</b><em>Finance ops · 12 months</em></span>
    </El>
  </>,

  /* 3 · Kick-off: the route on the map, the plane, the boarding pass, the team */
  <>
    <El i={0} x={18} y={18} w={604} h={250} cls="lx-glass lx-map">
      <svg className="lx-route" viewBox="0 0 604 250"><path d="M150 186 C 240 40, 380 30, 464 84" pathLength={1} /></svg>
      <span className="lx-plane"><Ico d={I.jet} s={26} /></span>
      <span className="lx-pin" style={{ left: 150, top: 186 }}><i /><b>Madrid</b></span>
      <span className="lx-pin is-to" style={{ left: 464, top: 84 }}><i /><b>Amsterdam</b></span>
      <span className="lx-map-k">2 h 25 min · direct</span>
    </El>
    <El i={7} x={30} y={290} w={344} h={140} cls="lx-card lx-pass">
      <div className="lx-pass-main">
        <span className="lx-k">Boarding pass</span>
        <div className="lx-pass-route"><b>MAD</b><span><Ico d={I.jet} s={18} /></span><b>AMS</b></div>
        <div className="lx-pass-meta"><span><em>Flight</em>NX 204</span><span><em>Boards</em>08:40</span><span><em>Seat</em>4A</span></div>
      </div>
      <div className="lx-pass-stub"><i /><i /><i /><i /><i /><i /><i /><i /></div>
    </El>
    <El i={10} x={392} y={290} w={230} h={140} cls="lx-card lx-team">
      <span className="lx-k">Kick-off</span>
      <b>Monday · 9:00</b>
      <div className="lx-stack">{[["IB", 4], ["SR", 2], ["MO", 3], ["LF", 1]].map(([t, c], k) => <Av key={k} t={t as string} c={c as number} s={32} />)}</div>
      <em>Team of 4 · Amsterdam office</em>
    </El>
  </>,

  /* 4 · Project: the plan fills up, today moves on, the hours add up */
  <>
    <El i={0} x={18} y={22} w={604} h={268} cls="lx-card lx-gantt">
      <div className="lx-head"><span><b>Finance operations</b><em>Halden &amp; Moss</em></span><span className="lx-badge is-soft">Week 6 of 12</span></div>
      <div className="lx-grid">{Array.from({ length: 6 }, (_, k) => <i key={k} />)}</div>
      {[["Discovery", 0, 22, "is-done"], ["Design", 16, 30, "is-done"], ["Build", 38, 40, "is-now"], ["Launch", 74, 22, ""]].map(([n, x, w, s], k) => (
        <div key={k} className={`lx-row ${s}`} style={v({ "--j": k })}>
          <span className="lx-row-k">{n}</span>
          <span className="lx-track"><i style={{ left: `${x}%`, width: `${w}%` }}><s /></i></span>
        </div>
      ))}
      <span className="lx-today"><b>Today</b></span>
    </El>
    <El i={6} x={30} y={310} w={286} cls="lx-glass lx-hours">
      <span className="lx-k">Hours</span>
      <b>412 <em>/ 520 h</em></b>
      <span className="lx-bar"><i /></span>
    </El>
    <El i={8} x={334} y={310} w={288} cls="lx-card lx-people">
      <span className="lx-k">Team</span>
      <div className="lx-people-row">{[["IB", 4, "Lead"], ["SR", 2, "Controller"], ["MO", 3, "Analyst"], ["TV", 5, "Payroll"]].map(([t, c, r], k) => <span key={k}><Av t={t as string} c={c as number} s={30} /><em>{r}</em></span>)}</div>
      <span className="lx-margin">Margin <b>38%</b></span>
    </El>
  </>,

  /* 5 · Billing: the invoice goes out, gets paid, the month fills up */
  <>
    <El i={0} x={34} y={30} w={312} cls="lx-card lx-inv">
      <div className="lx-head"><span><span className="lx-k">Invoice</span><b>INV-0142</b></span><span className="lx-state"><em className="is-sent">Sent</em><em className="is-paid">Paid</em></span></div>
      <span className="lx-to">Halden &amp; Moss · Amsterdam</span>
      {[["Monthly close", "6,000 €"], ["Payroll · 140 people", "4,200 €"], ["Reporting pack", "1,800 €"]].map(([n, a], k) => <div key={k} className="lx-item" style={v({ "--j": k })}><span>{n}</span><b>{a}</b></div>)}
      <div className="lx-total"><span>Total</span><b>12,000 €</b></div>
      <span className="lx-stamp is-paid">Paid</span>
    </El>
    <El i={21} x={368} y={40} w={256} cls="lx-glass lx-toast">
      <span className="lx-ico is-lime"><Ico d={I.bank} /></span>
      <span><b>Payment received</b><em className="lx-plus-t">+ 12,000 €</em></span>
    </El>
    <El i={5} x={368} y={150} w={256} h={230} cls="lx-card lx-chart">
      <span className="lx-k">Cash in · November</span>
      <b className="lx-big">86,400 €</b>
      <div className="lx-bars">{[38, 52, 44, 66, 58, 92].map((hh, k) => <i key={k} style={v({ "--h": `${hh}%`, "--j": k })} className={k === 5 ? "is-lime" : ""} />)}</div>
    </El>
  </>,

  /* 6 · Renewal: health goes up, the contract renews, the client grows */
  <>
    <El i={0} x={18} y={24} w={292} h={226} cls="lx-card lx-gauge">
      <span className="lx-k">Client health</span>
      <svg viewBox="0 0 200 112"><path className="is-track" d="M16 100 A84 84 0 0 1 184 100" /><path className="is-val" d="M16 100 A84 84 0 0 1 184 100" pathLength={100} /></svg>
      <b className="lx-gauge-n">92</b><em className="lx-gauge-k">Excellent</em>
    </El>
    <El i={3} x={328} y={24} w={294} h={226} cls="lx-glass lx-renew">
      <div className="lx-renew-top"><span className="lx-ico is-lime lx-spin"><Ico d={I.loop} /></span><span><b>Renewed</b><em>12 more months</em></span><span className="lx-up"><Ico d={I.up} s={14} />+18%</span></div>
      <svg className="lx-line" viewBox="0 0 260 110"><path className="is-area" d="M4 100 L44 84 L84 88 L124 66 L164 60 L204 38 L256 18 L256 110 L4 110 Z" /><path className="is-stroke" d="M4 100 L44 84 L84 88 L124 66 L164 60 L204 38 L256 18" pathLength={1} /></svg>
    </El>
    <El i={7} x={96} y={276} w={448} cls="lx-card lx-client">
      <Av t="HM" c={1} s={54} />
      <span className="lx-client-txt"><b>Halden &amp; Moss</b><em>Client since 2025 · 3 projects · Amsterdam</em></span>
      <span className="lx-chips is-col"><span><Ico d={I.check} s={12} />On time 100%</span><span><Ico d={I.check} s={12} />NPS 9</span></span>
    </El>
  </>,
];

export default function LoginStory() {
  const [step, setStep] = useState(0);
  const [prev, setPrev] = useState(-1);
  const [paused, setPaused] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const [k, setK] = useState(1);
  const still = (() => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } })();

  const go = (n: number) => { setStep((s) => { if (s !== n) setPrev(s); return n; }); };

  useEffect(() => {
    if (still || paused) return;
    const t = window.setTimeout(() => go((step + 1) % STORY_STEPS.length), STEP_MS);
    return () => window.clearTimeout(t);
  }, [step, still, paused]);
  useEffect(() => {
    if (prev < 0) return;
    const t = window.setTimeout(() => setPrev(-1), 650);
    return () => window.clearTimeout(t);
  }, [prev, step]);

  /* the stage is drawn at 640 × 460 and scaled to the panel */
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { const r = el.getBoundingClientRect(); setK(Math.max(0.45, Math.min(1.22, (r.width - 48) / W, (r.height - 24) / H))); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className={`ls-story is-s${step}`} aria-hidden="true">
      <div className="ls-tint">{STORY_STEPS.map((_, n) => <i key={n} className={`is-t${n} ${n === step ? "is-on" : ""}`} />)}</div>
      <div className="ls-stage" ref={stageRef}>
        <div className="lx-world" style={{ width: W, height: H, transform: `scale(${k})` }}>
          {SCENES.map((sc, n) => (
            <div key={n} className={`lx-scene is-x${n} ${n === step ? "is-on" : n === prev ? "is-off" : ""}`}>{sc}</div>
          ))}
        </div>
      </div>
      <div className="ls-copy">
        <p className="ls-eyebrow"><i />How Next works</p>
        <h2 className="ls-head">From the first contact <span>to the last invoice.</span></h2>
        <p className="ls-line"><span key={step}>{STORY_STEPS[step].line}</span></p>
        <div className="ls-steps" onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)}>
          {STORY_STEPS.map((c, n) => (
            <button key={c.k} type="button" tabIndex={-1} className={`${n === step ? "is-on" : ""} ${n < step ? "is-done" : ""}`} onClick={() => go(n)}>
              <span className="ls-step-n">{String(n + 1).padStart(2, "0")}</span>
              <span className="ls-step-k">{c.k}</span>
              <span className="ls-step-bar"><i key={`${step}-${paused}`} style={{ animationDuration: `${STEP_MS}ms`, animationPlayState: paused ? "paused" : "running" }} /></span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
