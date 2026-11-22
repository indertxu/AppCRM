import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LoginWorld } from "./loginWorld";
import "./LoginStory.css";

/* ---------------------------------------------------------------------------
   The sign-in page's story panel: the whole Next process, as seven little 3D
   worlds on one floating island that morphs from one into the next
   (loginWorld.ts, three.js — loaded lazily so the form never waits for it).
   This file is the frame around it: the step's card, the headline, the line
   for the step and the seven steps (click one to jump, hover to pause).
   Decorative: aria-hidden.
   --------------------------------------------------------------------------- */

export const STORY_STEPS: { k: string; title: string; sub: string; line: string }[] = [
  { k: "Contact", title: "New contact", sub: "Lucía Ferrer · Halden & Moss", line: "Every e-mail, call and meeting lands in one place." },
  { k: "Deal", title: "Opportunity won", sub: "48,000 € · proposal accepted", line: "Deals move through the pipeline — you see every step." },
  { k: "Contract", title: "Contract signed", sub: "Halden & Moss · 12 months", line: "Signed, stamped — and the project is already set up." },
  { k: "Kick-off", title: "Kick-off", sub: "Madrid → Amsterdam · team of 4", line: "The team, the trips and day one, on one calendar." },
  { k: "Project", title: "Project on track", sub: "Milestone 3 of 5 · on budget", line: "Floor by floor: hours, milestones and margin, live." },
  { k: "Billing", title: "Invoice paid", sub: "INV-0142 · 12,000 €", line: "The invoice goes out; the money comes home." },
  { k: "Renewal", title: "Renewed", sub: "+18% · health 92 / 100", line: "Happy clients grow — and you see it coming." },
];
const STEP_MS = 6200;

const ICONS: ReactNode[] = [
  <><path d="M4 6h16v12H4z" /><path d="M4 7l8 6 8-6" /></>,
  <><path d="M4 19h16" /><path d="M6 15l4-4 3 3 5-6" /><path d="M15 8h3v3" /></>,
  <><path d="M4 17c3-5 5 2 8-3s3 3 6 0" /><path d="M4 21h16" /></>,
  <><path d="M2.5 13.5l19-6-3.5 8-6-1.5-3 4.5-1-5.5z" /></>,
  <><path d="M5 20V12M10 20V6M15 20v-9M20 20V9" /></>,
  <><path d="M7 3h10v18l-2.5-1.6L12 21l-2.5-1.6L7 21z" /><path d="M9.5 12.5l2 2 3.5-4" /></>,
  <><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4.5V11h-6.5" /></>,
];

export default function LoginStory() {
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);
  const [ready, setReady] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const copyRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<LoginWorld | null>(null);
  const stepRef = useRef(step);
  stepRef.current = step;
  const still = (() => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } })();

  /* the 3D world, loaded after the page is up */
  useEffect(() => {
    let dead = false;
    const fontsReady = (document.fonts?.ready ?? Promise.resolve()).then(() => undefined);
    const timeout = new Promise<void>((r) => window.setTimeout(r, 1200));
    Promise.all([import("./loginWorld"), Promise.race([fontsReady, timeout])]).then(([m]) => {
      if (dead || !canvasRef.current) return;
      const w = m.createWorld(canvasRef.current, { step: stepRef.current, reduced: still });
      if (!w) return;
      worldRef.current = w;
      if (copyRef.current) w.setInset(copyRef.current.offsetHeight);
      setReady(true);
    }).catch(() => { /* no WebGL: the panel keeps its gradient */ });
    return () => { dead = true; worldRef.current?.dispose(); worldRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { worldRef.current?.setStep(step); }, [step, ready]);

  /* the copy covers the bottom of the panel: the world centres above it */
  useEffect(() => {
    const el = copyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => worldRef.current?.setInset(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (still || paused) return;
    const t = window.setTimeout(() => setStep((s) => (s + 1) % STORY_STEPS.length), STEP_MS);
    return () => window.clearTimeout(t);
  }, [step, still, paused]);

  const s = STORY_STEPS[step];
  return (
    <div className={`ls-story is-s${step} ${ready ? "is-ready" : ""}`} aria-hidden="true">
      <div className="ls-tint">{STORY_STEPS.map((_, k) => <i key={k} className={`is-t${k} ${k === step ? "is-on" : ""}`} />)}</div>
      <canvas ref={canvasRef} className="ls-canvas" />

      <div className="ls-cards">
        {STORY_STEPS.map((c, k) => (
          <div key={c.k} className={`ls-card is-c${k} ${k === step ? "is-on" : ""}`}>
            <span className="ls-card-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{ICONS[k]}</svg></span>
            <span className="ls-card-txt">
              <b>{c.title}</b>
              <em>{c.sub}</em>
              {k === 1 && <span className="ls-meter"><i /></span>}
              {k === 2 && <svg className="ls-sign" viewBox="0 0 120 22"><path d="M2 16c10-14 14 6 22-2s6-10 12-2 10 8 16-2 8 6 14 4 12-8 20-6 12 4 30 2" pathLength={1} /></svg>}
              {k === 4 && <span className="ls-bars"><i /><i /><i /><i /></span>}
            </span>
            {(k === 2 || k === 5) && <span className="ls-card-ok"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></span>}
          </div>
        ))}
      </div>

      <div className="ls-copy" ref={copyRef}>
        <p className="ls-eyebrow"><i />How Next works</p>
        <h2 className="ls-head">From the first contact <span>to the last invoice.</span></h2>
        <p className="ls-line"><span key={step}>{s.line}</span></p>
        <div className="ls-steps" onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)}>
          {STORY_STEPS.map((c, k) => (
            <button key={c.k} type="button" tabIndex={-1} className={`${k === step ? "is-on" : ""} ${k < step ? "is-done" : ""}`} onClick={() => setStep(k)}>
              <span className="ls-step-n">{String(k + 1).padStart(2, "0")}</span>
              <span className="ls-step-k">{c.k}</span>
              <span className="ls-step-bar"><i key={`${step}-${paused}`} style={{ animationDuration: `${STEP_MS}ms`, animationPlayState: paused ? "paused" : "running" }} /></span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
