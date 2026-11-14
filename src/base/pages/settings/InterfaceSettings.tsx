import { useEffect, useState } from "react";
import { DOCK_ITEMS, DOCK_ORDER_KEY, DOCK_ORDER_EVENT, orderDock } from "../../framework/Dock";
import { setDockMode, readDockMode, modeFromDetail, dockModeFrom, DOCK_MODE_EVENT, DOCK_COMPACT_KEY, DOCK_COMPACT_EVENT, type DockLabelMode } from "../../framework/dockPrefs";
import { LANGS, getLang, setLang, type Lang } from "../../../components/framework/i18n/i18n";
import { loadPrefs, savePref } from "../companies/companiesApi";
import type { PageKey } from "../../framework/pageAccess";
import "./InterfaceSettings.css";

/* =====================================================================
   Settings › Interface (BASE): the language, how the sidebar shows its
   names (on hover / under / beside — the same choice as the full app,
   saved in prefs.dockLabelMode), small sidebar icons (prefs.dockCompact)
   and your own toolbar order (prefs.dockOrder). All saved with the person.
   ===================================================================== */

const I = {
  globe: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>,
  side: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></svg>,
  list: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1" /><circle cx="4.5" cy="12" r="1" /><circle cx="4.5" cy="18" r="1" /></svg>,
  tick: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>,
  back: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>,
  up: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 15l6-6 6 6" /></svg>,
  down: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>,
};

const MODES: [DockLabelMode, string, string][] = [
  ["hover", "On hover", "Icons only — the name when you point at one"],
  ["below", "Under the icons", "A small name under each icon"],
  ["side", "Beside the icons", "A wide sidebar with the full names"],
];

export default function InterfaceSettings({ uid, canSee, onBack }: { uid: string | null; canSee: (p: PageKey) => boolean; onBack: () => void }) {
  // ---- how the sidebar shows names ----
  const [mode, setModeState] = useState<DockLabelMode>(readDockMode);
  useEffect(() => {
    const on = (e: Event) => setModeState(modeFromDetail((e as CustomEvent).detail));
    window.addEventListener(DOCK_MODE_EVENT, on);
    loadPrefs().then((p) => { const m = dockModeFrom(p, null); if (m) setModeState(m); }).catch(() => {});
    return () => window.removeEventListener(DOCK_MODE_EVENT, on);
  }, []);
  const chooseMode = (m: DockLabelMode) => { setModeState(m); void setDockMode(m, uid); };

  // ---- small icons ----
  const [compact, setCompact] = useState<boolean>(() => { try { return localStorage.getItem(DOCK_COMPACT_KEY) === "true"; } catch { return false; } });
  useEffect(() => { loadPrefs().then((p) => { if (typeof p.dockCompact === "boolean") setCompact(p.dockCompact); }).catch(() => {}); }, []);
  const toggleCompact = () => {
    const next = !compact;
    setCompact(next);
    try { localStorage.setItem(DOCK_COMPACT_KEY, String(next)); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent(DOCK_COMPACT_EVENT, { detail: next }));
    savePref("dockCompact", next).catch(() => {});
  };

  // ---- the toolbar order ----
  const [order, setOrder] = useState<string[]>(() => { try { const v = JSON.parse(localStorage.getItem(DOCK_ORDER_KEY) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } });
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  useEffect(() => { loadPrefs().then((p) => { if (Array.isArray(p.dockOrder)) setOrder(p.dockOrder); }).catch(() => {}); }, []);
  const saveOrder = (next: string[]) => {
    setOrder(next);
    try { localStorage.setItem(DOCK_ORDER_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent(DOCK_ORDER_EVENT, { detail: next }));
    savePref("dockOrder", next).catch(() => {});
  };
  const shown = orderDock(DOCK_ITEMS.filter((it) => canSee(it.page)), order);
  const dropOn = (target: string, after: boolean) => {
    if (!drag || drag === target) return;
    const paths = orderDock(DOCK_ITEMS, order).map((it) => it.path).filter((p) => p !== drag);
    paths.splice(paths.indexOf(target) + (after ? 1 : 0), 0, drag);
    saveOrder(paths);
  };
  const move = (path: string, by: number) => {
    const paths = orderDock(DOCK_ITEMS, order).map((it) => it.path);
    const vis = shown.map((it) => it.path);
    const i = vis.indexOf(path), j = i + by;
    if (j < 0 || j >= vis.length) return;
    const a = paths.indexOf(vis[i]), b = paths.indexOf(vis[j]);
    [paths[a], paths[b]] = [paths[b], paths[a]];
    saveOrder(paths);
  };

  const lang = getLang();

  return (
    <div className="st ifs">
      <header className="ifs-head">
        <button type="button" className="ifs-back" onClick={onBack} aria-label="Back to Settings">{I.back}</button>
        <div>
          <h1>Interface</h1>
          <p>Only for you — the language, the sidebar and its order</p>
        </div>
      </header>

      <div className="ifs-grid">
        <div className="ifs-col">
          {/* language */}
          <section className="ifs-card" style={{ ["--a" as string]: "#3b82f6" }}>
            <div className="ifs-card-h">
              <span className="ifs-ico">{I.globe}</span>
              <div><b>Language</b><small>Every page, menu and message. Names, notes and what people write stay as they are.</small></div>
            </div>
            <div className="ifs-langs" role="radiogroup" aria-label="Language">
              {LANGS.map((l) => (
                <button key={l.v} type="button" role="radio" aria-checked={lang === l.v} translate="no"
                  className={`ifs-lang ${lang === l.v ? "is-on" : ""}`}
                  onClick={() => { if (l.v !== lang) void setLang(l.v as Lang, { save: (x) => savePref("lang", x) }); }}>
                  <span className="ifs-flag" aria-hidden="true">{l.flag}</span>
                  <b>{l.native}</b>
                  <em>{l.v === "en" ? "Default" : l.label}</em>
                  {lang === l.v && <i className="ifs-tick" aria-hidden="true">{I.tick}</i>}
                </button>
              ))}
            </div>
          </section>

          {/* sidebar */}
          <section className="ifs-card" style={{ ["--a" as string]: "#e0a13c" }}>
            <div className="ifs-card-h">
              <span className="ifs-ico">{I.side}</span>
              <div><b>Sidebar</b><small>How it shows each page's name. The button at the foot of the sidebar widens it too.</small></div>
            </div>
            <div className="ifs-modes" role="radiogroup" aria-label="Menu labels">
              {MODES.map(([m, t, d]) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} className={`ifs-mode ${mode === m ? "is-on" : ""}`} onClick={() => chooseMode(m)}>
                  <span className={`ifs-pv is-${m} ${compact ? "is-sm" : ""}`} aria-hidden="true">
                    <span className="ifs-pv-rail">
                      {[0, 1, 2, 3].map((i) => <span key={i} className={i === 1 ? "is-on" : ""}><i />{m !== "hover" && <u />}</span>)}
                    </span>
                    <span className="ifs-pv-page" />
                  </span>
                  <b>{t}</b>
                  <em>{d}</em>
                  {mode === m && <i className="ifs-tick" aria-hidden="true">{I.tick}</i>}
                </button>
              ))}
            </div>
            <button type="button" role="switch" aria-checked={compact} className={`ifs-switch-row ${compact ? "is-on" : ""}`} onClick={toggleCompact}>
              <span><b>Small icons</b><small>A slimmer sidebar, with the names you chose. It scrolls instead of squashing on a short or zoomed-in window.</small></span>
              <span className="ifs-switch"><i /></span>
            </button>
          </section>
        </div>

        {/* order */}
        <section className="ifs-card is-order" style={{ ["--a" as string]: "#12b57f" }}>
          <div className="ifs-card-h">
            <span className="ifs-ico">{I.list}</span>
            <div><b>Toolbar order</b><small>Drag the pages into the order that suits you.</small></div>
            {order.length > 0 && <button type="button" className="ifs-reset" onClick={() => saveOrder([])}>Reset</button>}
          </div>
          <div className="ifs-order">
            {shown.map((it, i) => (
              <div key={it.path} draggable
                className={`ifs-row ${drag === it.path ? "is-dragging" : ""} ${over === it.path && drag !== it.path ? "is-over" : ""}`}
                onDragStart={(e) => { setDrag(it.path); e.dataTransfer.effectAllowed = "move"; }}
                onDragEnd={() => { setDrag(null); setOver(null); }}
                onDragOver={(e) => { if (!drag) return; e.preventDefault(); if (over !== it.path) setOver(it.path); }}
                onDrop={(e) => { e.preventDefault(); const b = e.currentTarget.getBoundingClientRect(); dropOn(it.path, e.clientY > b.top + b.height / 2); setDrag(null); setOver(null); }}>
                <span className="ifs-pos">{i + 1}</span>
                <span className="ifs-row-ico">{it.icon}</span>
                <span className="ifs-row-name">{it.label}</span>
                <button type="button" className="ifs-mv" onClick={() => move(it.path, -1)} disabled={i === 0} aria-label={`Move ${it.label} up`}>{I.up}</button>
                <button type="button" className="ifs-mv" onClick={() => move(it.path, 1)} disabled={i === shown.length - 1} aria-label={`Move ${it.label} down`}>{I.down}</button>
                <span className="ifs-grip" aria-hidden="true">⋮⋮</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
