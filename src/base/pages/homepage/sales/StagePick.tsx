/**
 * Home · "Pipeline by stage" — one dropdown for which pipeline the card shows
 * and which of its stages (none picked = every stage). Same trigger as the
 * framework Select (sel-trigger is-sm); the menu is portalled to <body>.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import "./StagePick.css";

interface Props {
  pipes: { id: string; name: string }[];
  pipe: string | null;
  stages: { id: string; name: string; color: string | null }[];
  /** the stages picked; [] = all */
  pick: string[];
  onChange: (pipe: string | null, pick: string[]) => void;
}

const Tick = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;

export default function StagePick({ pipes, pipe, stages, pick, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxH: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const all = pick.length === 0 || pick.length >= stages.length;
  const on = (id: string) => all || pick.includes(id);
  const name = pipes.find((p) => p.id === pipe)?.name ?? "Pipeline";

  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(300, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
    const below = window.innerHeight - r.bottom - 14, above = r.top - 14;
    const up = below < 260 && above > below;
    const maxH = Math.max(180, Math.min(460, up ? above : below));
    setPos({ top: up ? Math.max(8, r.top - 6 - maxH) : r.bottom + 6, left, width, maxH });
  };
  useLayoutEffect(() => { if (open) place(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const off = (e: PointerEvent) => { const t = e.target as Node; if (!menu.current?.contains(t) && !btn.current?.contains(t)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); btn.current?.focus(); } };
    const re = (e?: Event) => { if (e && menu.current?.contains(e.target as Node)) return; place(); };
    document.addEventListener("pointerdown", off, true);
    window.addEventListener("keydown", esc, true);
    window.addEventListener("resize", re);
    window.addEventListener("scroll", re, true);
    return () => {
      document.removeEventListener("pointerdown", off, true);
      window.removeEventListener("keydown", esc, true);
      window.removeEventListener("resize", re);
      window.removeEventListener("scroll", re, true);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  /** every stage on, or none left: back to "all" */
  const set = (next: string[]) => onChange(pipe, next.length === 0 || next.length >= stages.length ? [] : stages.filter((s) => next.includes(s.id)).map((s) => s.id));
  const toggle = (id: string) => {
    const cur = all ? stages.map((s) => s.id) : pick;
    if (cur.includes(id)) { if (cur.length > 1) set(cur.filter((x) => x !== id)); }
    else set([...cur, id]);
  };

  return (
    <>
      <button ref={btn} type="button" className={`sel-trigger is-sm sxp-trig ${open ? "is-open" : ""}`} onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog" aria-expanded={open} title={all ? `${name} · every stage` : `${name} · ${pick.length} of ${stages.length} stages`}>
        <span>{name}</span>
        {!all && <em className="sxp-n">{pick.length}/{stages.length}</em>}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && pos && createPortal(
        <div ref={menu} className="sel-pop is-sm sxp-pop" role="dialog" aria-label="Pipeline and stages" style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxH }}>
          {pipes.length > 1 && (
            <>
              <b className="sxp-h">Pipeline</b>
              <div role="radiogroup" aria-label="Pipeline">
                {pipes.map((p) => (
                  <button key={p.id} type="button" role="radio" aria-checked={p.id === pipe} className={`sel-option sxp-pipe ${p.id === pipe ? "is-sel" : ""}`}
                    onClick={() => { if (p.id !== pipe) onChange(p.id, []); }}>
                    <span>{p.name}</span>{p.id === pipe && <Tick />}
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="sxp-h is-row">
            <b>Stages</b>
            <span>{all ? `All ${stages.length}` : `${pick.length} of ${stages.length}`}</span>
            <button type="button" className="sxp-all" disabled={all} onClick={() => set([])}>Show all</button>
          </div>
          {stages.length === 0 && <p className="sxp-none">This pipeline has no stages yet.</p>}
          {stages.map((s) => (
            <div key={s.id} className={`sxp-st ${on(s.id) ? "is-on" : ""}`}>
              <button type="button" role="checkbox" aria-checked={on(s.id)} className="sxp-st-b" onClick={() => toggle(s.id)}
                disabled={on(s.id) && !all && pick.length === 1} title={on(s.id) && !all && pick.length === 1 ? "At least one stage stays on" : undefined}>
                <span className="sxp-box">{on(s.id) && <Tick />}</span>
                <i style={{ ["--c" as string]: s.color || "#12b57f" } as CSSProperties} />
                <span className="sxp-st-t">{s.name}</span>
              </button>
              <button type="button" className="sxp-only" onClick={() => set([s.id])} title={`Show only ${s.name}`}>Only</button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
