/* =====================================================================
   Settings › Pipelines — the library of ready-made pipelines and the
   guide that walks you through building your first one.
     <PipelineLibrary>  15 sectors: pick one, see its phases, use it or
                        shape it in the guide.
     <PipelineGuide>    5 animated steps: what a pipeline is → your
                        business → your phases → how likely each one
                        wins → name it. Creates the pipeline at the end.
   ===================================================================== */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Pipeline } from "./pipelineApi";
import { TEMPLATES, TPL_GROUPS, GENERIC, createPipelineFrom, freeName, type PipelineTemplate, type TplGroup, type TplPhase } from "./pipelineTemplates";
import "./PipelineLibrary.css";

const Ico = ({ d, size = 18 }: { d: string; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const P = {
  close: "M6 6l12 12M18 6L6 18",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  arrowR: "M5 12h14M13 6l6 6-6 6",
  arrowL: "M19 12H5M11 6l-6 6 6 6",
  up: "M12 19V5M6 11l6-6 6 6",
  down: "M12 5v14M6 13l6 6 6-6",
  plus: "M12 5v14M5 12h14",
  check: "M5 12l5 5 9-10",
  wand: "M15 4V2M15 10V8M11 6h2M17 6h2M5 21l11-11M14 5l1 1",
  book: "M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 21a2 2 0 0 1 2-2h13v2",
  trophy: "M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4",
  x: "M18 6L6 18M6 6l12 12",
};

/** A full-screen sheet over the page; Esc closes it. */
function Sheet({ onClose, label, wide, children }: { onClose: () => void; label: string; wide?: boolean; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return createPortal(
    <div className="plib-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`plib-sheet ${wide ? "is-wide" : ""}`} role="dialog" aria-modal="true" aria-label={label}>{children}</div>
    </div>,
    document.body,
  );
}

/** The phases of a pipeline as a line going down, appearing one by one. */
function Journey({ phases, color, endings = true, k }: { phases: TplPhase[]; color: string; endings?: boolean; k: string }) {
  return (
    <ol className="plib-journey" key={k} style={{ ["--c" as string]: color }}>
      {phases.map((p, i) => (
        <li key={i} style={{ ["--i" as string]: i }}>
          <span className="plib-j-dot">{i + 1}</span>
          <span className="plib-j-txt"><b>{p.name}</b>{p.tip && <small>{p.tip}</small>}</span>
          <span className="plib-j-prob" title="Chance a deal here ends Won"><span className="plib-j-bar"><i style={{ width: `${p.prob}%` }} /></span>{p.prob}%</span>
        </li>
      ))}
      {endings && (
        <li className="plib-j-end" style={{ ["--i" as string]: phases.length }}>
          <span className="plib-j-fork"><em className="is-win">Won</em><em className="is-loss">Lost</em></span>
        </li>
      )}
    </ol>
  );
}

// ============================ Library ============================
export function PipelineLibrary({ taken, folderId, onClose, onCreated, onCustomize }: {
  taken: string[]; folderId?: string | null;
  onClose: () => void; onCreated: (p: Pipeline) => void; onCustomize: (t: PipelineTemplate) => void;
}) {
  const [group, setGroup] = useState<TplGroup | "All">("All");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<PipelineTemplate | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const list = TEMPLATES.filter((t) => (group === "All" || t.group === group)
    && (!q.trim() || fold(`${t.sector} ${t.name} ${t.blurb} ${t.phases.map((p) => p.name).join(" ")}`).includes(fold(q.trim()))));
  const pick = (t: PipelineTemplate) => { setSel(t); setName(freeName(t.name, taken)); setErr(null); };
  const use = async () => {
    if (!sel || busy) return;
    setBusy(true); setErr(null);
    const r = await createPipelineFrom({ name, phases: sel.phases, folderId, description: `From the library: ${sel.sector}` });
    setBusy(false);
    if (typeof r === "string") { setErr(r); return; }
    onCreated(r);
  };
  return (
    <Sheet onClose={onClose} label="Pipeline library" wide>
      <header className="plib-head">
        <span className="plib-head-ic"><Ico d={P.book} size={20} /></span>
        <div><h2>Pipeline library</h2><p>{TEMPLATES.length} pipelines ready for your sector — use one as it is, or shape it in the guide.</p></div>
        <label className="plib-search"><Ico d={P.search} size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a sector or a phase" autoFocus /></label>
        <button className="plib-x" onClick={onClose} aria-label="Close"><Ico d={P.close} /></button>
      </header>
      <nav className="plib-groups" aria-label="Sectors">
        {(["All", ...TPL_GROUPS] as const).map((g) => (
          <button key={g} className={group === g ? "is-on" : ""} onClick={() => setGroup(g)}>
            {g}<span>{g === "All" ? TEMPLATES.length : TEMPLATES.filter((t) => t.group === g).length}</span>
          </button>
        ))}
      </nav>
      <div className={`plib-body ${sel ? "has-sel" : ""}`}>
        <div className="plib-grid">
          {list.map((t, i) => (
            <button key={t.key} className={`plib-card ${sel?.key === t.key ? "is-sel" : ""}`} style={{ ["--c" as string]: t.color, ["--i" as string]: i }} onClick={() => pick(t)}>
              <span className="plib-card-ic"><Ico d={t.icon} size={20} /></span>
              <b>{t.sector}</b>
              <small>{t.blurb}</small>
              <span className="plib-card-dots" aria-label={`${t.phases.length} phases`}>
                {t.phases.map((_, j) => <i key={j} style={{ opacity: 0.35 + (0.65 * (j + 1)) / t.phases.length }} />)}
                <em>{t.phases.length} phases</em>
              </span>
            </button>
          ))}
          {!list.length && <p className="plib-none">No sector matches “{q}”. Try the guide — it builds one for anything.</p>}
        </div>
        <aside className="plib-detail" aria-live="polite">
          {sel ? (
            <div className="plib-det-in" key={sel.key} style={{ ["--c" as string]: sel.color }}>
              <div className="plib-det-top">
                <span className="plib-det-ic"><Ico d={sel.icon} size={24} /></span>
                <div><small>{sel.group}</small><h3>{sel.sector}</h3></div>
              </div>
              <p className="plib-det-blurb">{sel.blurb}</p>
              <Journey phases={sel.phases} color={sel.color} k={sel.key} />
              <label className="plib-field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
              {err && <p className="plib-err">{err}</p>}
              <div className="plib-det-acts">
                <button className="plib-btn" disabled={busy || !name.trim()} onClick={() => void use()}>{busy ? <span className="plib-spin" /> : <Ico d={P.check} size={16} />}{busy ? "Creating…" : "Use this pipeline"}</button>
                <button className="plib-btn-ghost" onClick={() => onCustomize(sel)}><Ico d={P.wand} size={16} />Shape it in the guide</button>
              </div>
            </div>
          ) : (
            <div className="plib-det-empty">
              <span className="plib-det-empty-ic"><Ico d={P.book} size={26} /></span>
              <b>Pick a sector</b>
              <p>See its phases and how likely a deal in each one is to close.</p>
            </div>
          )}
        </aside>
      </div>
    </Sheet>
  );
}

// ============================ Guide ============================
const SUGGEST = ["Discovery call", "Demo", "Visit", "Proposal sent", "Follow-up", "Negotiation", "Contract sent", "Deposit paid"];
const STEPS = [
  { t: "What's a pipeline?", c: "The road a deal travels", d: "Each phase is a step a client takes towards buying. Deals move along it, so you always see where every opportunity is — and what to do next." },
  { t: "Your business", c: "Start from your sector", d: "Pick what you do and we'll start you with the phases businesses like yours use. You'll change anything you like in the next step." },
  { t: "Your phases", c: "Name the steps", d: "Name each phase after what has happened (“Proposal sent”), not what you're waiting for. 3 to 7 phases work best — fewer and you lose sight, more and nobody keeps them up to date." },
  { t: "How likely to win?", c: "Odds per phase", d: "For each phase, how often does a deal there end up Won? It powers your forecast: a 10 000 € deal at 50% counts 5 000 €. Every pipeline ends in Won or Lost." },
  { t: "Name it", c: "Last step", d: "Give it a name your team recognises. Sales pipelines show up in Sales as a board." },
];

export function PipelineGuide({ taken, folderId, start, onClose, onCreated, onOpen }: {
  taken: string[]; folderId?: string | null; start?: PipelineTemplate | null;
  onClose: () => void; onCreated: (p: Pipeline) => void; onOpen: (p: Pipeline) => void;
}) {
  const [step, setStep] = useState(start ? 2 : 0);
  const [dir, setDir] = useState<1 | -1>(1);
  const [tpl, setTpl] = useState<PipelineTemplate | null>(start ?? null);
  const [phases, setPhases] = useState<TplPhase[]>(() => (start ? start.phases.map((p) => ({ ...p })) : []));
  const [endings, setEndings] = useState(true);
  const [name, setName] = useState(() => (start ? freeName(start.name, taken) : ""));
  const [isSales, setIsSales] = useState(true);
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<Pipeline | null>(null);
  const [fresh, setFresh] = useState<number | null>(null);
  const color = tpl?.color ?? "#12b57f";

  const go = (to: number) => { setDir(to > step ? 1 : -1); setErr(null); setStep(to); };
  const choose = (t: PipelineTemplate) => {
    setTpl(t); setPhases(t.phases.map((p) => ({ ...p }))); setName(freeName(t.name, taken));
    setDir(1); setStep(2);
  };
  const setPhase = (i: number, patch: Partial<TplPhase>) => setPhases((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const add = (n: string) => {
    const v = n.trim(); if (!v) return;
    setPhases((ps) => {
      const prev = ps[ps.length - 1]?.prob ?? 0;
      return [...ps, { name: v, prob: Math.min(95, prev + 15) }];
    });
    setFresh(phases.length); setNext("");
  };
  const remove = (i: number) => setPhases((ps) => ps.filter((_, j) => j !== i));
  const move = (i: number, d: -1 | 1) => setPhases((ps) => {
    const j = i + d; if (j < 0 || j >= ps.length) return ps;
    const n = [...ps]; [n[i], n[j]] = [n[j], n[i]]; return n;
  });
  const valid = phases.filter((p) => p.name.trim()).length;
  const health = valid === 0 ? "none" : valid < 3 ? "few" : valid > 7 ? "many" : "good";
  const create = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    const r = await createPipelineFrom({ name, phases, endings, isSales, folderId, description: tpl ? `Built with the guide from: ${tpl.sector}` : "Built with the guide" });
    setBusy(false);
    if (typeof r === "string") { setErr(r); return; }
    setDone(r); onCreated(r);
  };
  const canNext = step === 1 ? !!tpl : step === 2 ? valid > 0 : step === 4 ? !!name.trim() : true;
  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => { stageRef.current?.scrollTo({ top: 0 }); }, [step]);

  const S = STEPS[step];
  return (
    <Sheet onClose={onClose} label="Build your first pipeline">
      <div className="pg" style={{ ["--c" as string]: color }}>
        <header className="pg-head">
          <span className="pg-head-ic"><Ico d={P.wand} size={19} /></span>
          <div><h2>{done ? "Your pipeline is ready" : "Build your pipeline"}</h2><p>{done ? "You can change any phase later in the editor." : "A guided set-up — about two minutes."}</p></div>
          <button className="plib-x" onClick={onClose} aria-label="Close"><Ico d={P.close} /></button>
        </header>
        {!done && (
          <div className="pg-progress" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
            {STEPS.map((s, i) => (
              <button key={i} className={`${i === step ? "is-on" : ""} ${i < step ? "is-done" : ""}`} disabled={i > step || (i === 3 && !valid)} onClick={() => go(i)}>
                <i>{i < step ? <Ico d={P.check} size={12} /> : i + 1}</i><span>{s.t}</span>
              </button>
            ))}
            <span className="pg-progress-bar"><b style={{ width: `${(step / (STEPS.length - 1)) * 100}%` }} /></span>
          </div>
        )}

        {done ? (
          <div className="pg-done">
            <div className="pg-burst" aria-hidden="true">{Array.from({ length: 14 }, (_, i) => <i key={i} style={{ ["--a" as string]: `${i * (360 / 14)}deg`, ["--d" as string]: `${(i % 4) * 40}ms` }} />)}<span><Ico d={P.trophy} size={34} /></span></div>
            <h3>“{done.name}” is ready</h3>
            <p>{valid} phases{endings ? ", then Won or Lost" : ""}. {isSales ? "It's already on the Sales board." : ""}</p>
            <Journey phases={phases.filter((p) => p.name.trim())} color={color} endings={endings} k="done" />
            <div className="pg-done-acts">
              <button className="plib-btn" onClick={() => onOpen(done)}><Ico d={P.arrowR} size={16} />Open it in the editor</button>
              <button className="plib-btn-ghost" onClick={onClose}>Close</button>
            </div>
          </div>
        ) : (
          <div className="pg-body">
            <aside className="pg-coach" key={`c${step}`}>
              <span className="pg-coach-k">Step {step + 1} · {S.c}</span>
              <h3>{S.t}</h3>
              <p>{S.d}</p>
              {step === 2 && (
                <div className={`pg-health is-${health}`}>
                  <b>{valid} phase{valid === 1 ? "" : "s"}</b>
                  <span>{health === "good" ? "A good length." : health === "few" ? "A little short — most sales have 3 to 7 steps." : health === "many" ? "Long — could some steps be merged?" : "Add your first phase."}</span>
                </div>
              )}
              {step === 3 && <p className="pg-coach-tip">Tip: each phase should be more likely than the one before it.</p>}
            </aside>

            <div className={`pg-stage is-${dir > 0 ? "fwd" : "back"}`} key={`s${step}`} ref={stageRef}>
              {step === 0 && (
                <div className="pg-intro">
                  <div className="pg-board" aria-hidden="true">
                    {["Lead", "Proposal", "Negotiation", "Won"].map((c, i) => <div key={c} className={`pg-col ${i === 3 ? "is-won" : ""}`}><span>{c}</span></div>)}
                    {[0, 1, 2].map((i) => <div key={i} className="pg-deal" style={{ ["--d" as string]: `${i * 1.6}s`, ["--row" as string]: i }}><b>{["Acme S.L.", "Nexo Legal", "Clínica Sol"][i]}</b><small>{["12 000 €", "4 500 €", "8 200 €"][i]}</small></div>)}
                  </div>
                  <ul className="pg-points">
                    <li style={{ ["--i" as string]: 0 }}><b>Phases</b> — the steps a client takes, in order.</li>
                    <li style={{ ["--i" as string]: 1 }}><b>Deals</b> — each opportunity sits in one phase and moves forward.</li>
                    <li style={{ ["--i" as string]: 2 }}><b>Won or Lost</b> — every deal ends in one of the two.</li>
                  </ul>
                </div>
              )}

              {step === 1 && (
                <div className="pg-sectors">
                  {[...TEMPLATES, GENERIC].map((t, i) => (
                    <button key={t.key} className={`pg-sector ${tpl?.key === t.key ? "is-on" : ""}`} style={{ ["--c" as string]: t.color, ["--i" as string]: i }} onClick={() => choose(t)}>
                      <span><Ico d={t.icon} size={18} /></span>{t.sector}
                    </button>
                  ))}
                </div>
              )}

              {step === 2 && (
                <div className="pg-phases">
                  <ol>
                    {phases.map((p, i) => (
                      <li key={i} className={fresh === i ? "is-fresh" : ""} style={{ ["--i" as string]: i }}>
                        <span className="pg-num">{i + 1}</span>
                        <input value={p.name} onChange={(e) => setPhase(i, { name: e.target.value })} placeholder="Phase name" aria-label={`Phase ${i + 1}`} />
                        <span className="pg-row-acts">
                          <button onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up"><Ico d={P.up} size={14} /></button>
                          <button onClick={() => move(i, 1)} disabled={i === phases.length - 1} aria-label="Move down"><Ico d={P.down} size={14} /></button>
                          <button onClick={() => remove(i)} aria-label="Remove" className="is-del"><Ico d={P.x} size={14} /></button>
                        </span>
                      </li>
                    ))}
                  </ol>
                  <form className="pg-add" onSubmit={(e) => { e.preventDefault(); add(next); }}>
                    <span className="pg-num is-new"><Ico d={P.plus} size={14} /></span>
                    <input value={next} onChange={(e) => setNext(e.target.value)} placeholder="Add a phase and press Enter" />
                    {next.trim() && <button type="submit" className="plib-btn is-sm">Add</button>}
                  </form>
                  <div className="pg-suggest">
                    <small>Common phases</small>
                    {SUGGEST.filter((s) => !phases.some((p) => p.name.trim().toLowerCase() === s.toLowerCase())).map((s) => (
                      <button key={s} onClick={() => add(s)}><Ico d={P.plus} size={12} />{s}</button>
                    ))}
                  </div>
                </div>
              )}

              {step === 3 && (
                <div className="pg-odds">
                  {phases.filter((p) => p.name.trim()).map((p, i) => (
                    <label key={i} className="pg-odd" style={{ ["--i" as string]: i }}>
                      <span className="pg-num">{i + 1}</span>
                      <b>{p.name}</b>
                      <input type="range" min={0} max={100} step={5} value={p.prob} onChange={(e) => setPhase(phases.indexOf(p), { prob: Number(e.target.value) })} style={{ ["--v" as string]: `${p.prob}%` }} />
                      <em>{p.prob}%</em>
                    </label>
                  ))}
                  <button className={`pg-end ${endings ? "is-on" : ""}`} onClick={() => setEndings((v) => !v)} aria-pressed={endings}>
                    <span className="pg-end-fork"><em className="is-win">Won</em><em className="is-loss">Lost</em></span>
                    <span><b>End with Won and Lost</b><small>{endings ? "Deals close as won or lost — recommended." : "No ending phases (you can add them later)."}</small></span>
                    <i className="pg-switch" />
                  </button>
                </div>
              )}

              {step === 4 && (
                <div className="pg-name">
                  <label className="plib-field is-big"><span>Pipeline name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. New clients" autoFocus /></label>
                  <button className={`pg-end ${isSales ? "is-on" : ""}`} onClick={() => setIsSales((v) => !v)} aria-pressed={isSales}>
                    <span className="pg-end-ic"><Ico d={P.trophy} size={18} /></span>
                    <span><b>Sales pipeline</b><small>{isSales ? "Shows in Sales as a board, with a forecast." : "Only for tracking work after the sale."}</small></span>
                    <i className="pg-switch" />
                  </button>
                  <div className="pg-preview">
                    <small>Preview</small>
                    <Journey phases={phases.filter((p) => p.name.trim())} color={color} endings={endings} k={`p${phases.length}`} />
                  </div>
                  {err && <p className="plib-err">{err}</p>}
                </div>
              )}
            </div>
          </div>
        )}

        {!done && (
          <footer className="pg-foot">
            {step > 0 ? <button className="plib-btn-ghost" onClick={() => go(step - 1)}><Ico d={P.arrowL} size={16} />Back</button> : <span />}
            {step === 1 && !tpl && <span className="pg-foot-hint">Pick the closest one — or “Something else”.</span>}
            {step < 4
              ? <button className="plib-btn" disabled={!canNext} onClick={() => go(step + 1)}>{step === 0 ? "Let's build one" : "Next"}<Ico d={P.arrowR} size={16} /></button>
              : <button className="plib-btn" disabled={!canNext || busy} onClick={() => void create()}>{busy ? <span className="plib-spin" /> : <Ico d={P.check} size={16} />}{busy ? "Creating…" : "Create pipeline"}</button>}
          </footer>
        )}
      </div>
    </Sheet>
  );
}

/** Empty main area: a welcome with the two ways in. */
export function PipelineWelcome({ onGuide, onLibrary }: { onGuide: () => void; onLibrary: () => void }) {
  const sample = useMemo(() => TEMPLATES.slice(0, 6), []);
  return (
    <div className="pwel">
      <div className="pwel-art" aria-hidden="true">
        {sample.map((t, i) => <span key={t.key} style={{ ["--c" as string]: t.color, ["--i" as string]: i }}><Ico d={t.icon} size={18} /></span>)}
      </div>
      <h2>Set up your first pipeline</h2>
      <p>A pipeline is the road your deals travel, from first contact to Won. Start from your sector, or let the guide walk you through it.</p>
      <div className="pwel-acts">
        <button className="pwel-card is-main" onClick={onGuide}>
          <span><Ico d={P.wand} size={20} /></span>
          <b>Guide me</b>
          <small>5 short steps · about 2 minutes</small>
        </button>
        <button className="pwel-card" onClick={onLibrary}>
          <span><Ico d={P.book} size={20} /></span>
          <b>Browse the library</b>
          <small>{TEMPLATES.length} ready-made pipelines by sector</small>
        </button>
      </div>
    </div>
  );
}
