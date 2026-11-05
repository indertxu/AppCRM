import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import ContactsPage from "../contacts/ContactsPage";
import CompaniesPage from "../companies/CompaniesPage";
import ClientsPage from "../clients/ClientsPage";
import { usePageAccess } from "../../framework/pageAccess";
import OrbitAll from "./OrbitAll";
import { ORBIT_VIEWS, viewOf, type OrbitDraft, type OrbitHost, type OrbitKind, type OrbitView } from "./orbitTypes";
import { OrbitViewContext } from "./orbitContext";
import "./Orbit.css";
import "./OrbitLook.css";

/**
 * BASE · Orbit — everyone you deal with, in one page: /orbit (All), /orbit?view=contacts, /orbit?view=companies,
 * /orbit?view=clients (the Clients page, for whoever may open it in Page access).
 * The title switches between the three. "New" always opens one panel where you choose Contact or Company.
 *
 * Switching is meant to feel instant and smooth:
 *  - the three views stay mounted (the other two get ready in the background) and are only shown / hidden;
 *  - the current view lives in Orbit's state, not in the router: a switch writes the address with
 *    history.pushState (Back still works: Orbit listens to popstate), so the router doesn't re-render the
 *    three lists — with thousands of rows that re-render held the animation back ~200 ms;
 *  - the lists are memoised (Pane) and only re-render for their own reasons.
 * Links that do go through the router (/contacts → /orbit?view=contacts, ?new=1…) are followed too.
 *
 * The Contacts and Companies views are the full lists; Orbit hosts them and its own panel:
 * a second copy of the contacts / companies page that shows only its editor (OrbitOnly).
 */

type Panel = { kind: OrbitKind; id?: string; draft?: OrbitDraft; swapped?: boolean; n: number };
const urlOf = (v: OrbitView) => (v === "all" ? "/orbit" : `/orbit?view=${v}`);

/** One view. Memoised: switching views (or opening a panel) doesn't re-render the lists. */
const Pane = memo(function Pane({ v, host, onOpen }: { v: OrbitView; host: OrbitHost; onOpen: (kind: OrbitKind, id: string) => void }) {
  if (v === "all") return <OrbitAll onNew={host.onNew} onOpen={onOpen} refresh={host.refresh} />;
  if (v === "contacts") return <ContactsPage orbit={host} />;
  if (v === "clients") return <ClientsPage orbit={host} />;
  return <CompaniesPage orbit={host} />;
});

export default function OrbitPage() {
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  // Clients is a view only for whoever may open the Clients page (Page access); the rest follow Orbit's own access
  const access = usePageAccess();
  const clientsOk = access.ready ? access.canSee("clients") : true;
  const views = useMemo<OrbitView[]>(() => ORBIT_VIEWS.filter((v) => v !== "clients" || clientsOk), [clientsOk]);
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const asked = viewOf(sp.get("view"));
  const urlView: OrbitView = views.includes(asked) ? asked : "all";
  const [view, setView] = useState<OrbitView>(urlView);
  const viewRef = useRef(view);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [refresh, setRefresh] = useState(0);
  const seq = useRef(0);
  const open = useCallback((p: Omit<Panel, "n">) => setPanel({ ...p, n: ++seq.current }), []);

  // ---- the three views: mounted once, then only shown / hidden ----
  const [mounted, setMounted] = useState<OrbitView[]>(() => [urlView]);
  useEffect(() => {
    const t = window.setTimeout(() => setMounted((m) => [...m, ...viewsRef.current.filter((v) => !m.includes(v))]), 900);
    return () => window.clearTimeout(t);
  }, []);
  /** The view you just left (it fades out under the new one) and which way you went (the list glides in from there). */
  const [move, setMove] = useState<{ from: OrbitView; dir: 1 | -1 } | null>(null);
  const apply = useCallback((v: OrbitView) => {
    const from = viewRef.current;
    if (v === from || !viewsRef.current.includes(v)) return;
    viewRef.current = v;
    setMove({ from, dir: ORBIT_VIEWS.indexOf(v) > ORBIT_VIEWS.indexOf(from) ? 1 : -1 });
    setView(v);
    setMounted((m) => (m.includes(v) ? m : [...m, v]));
  }, []);
  /** The title's switch: Orbit's state + the address bar, without a router navigation. */
  const go = useCallback((v: OrbitView) => {
    if (v === viewRef.current || !viewsRef.current.includes(v)) return;
    apply(v);
    window.history.pushState(window.history.state, "", urlOf(v));
  }, [apply]);
  // Back / Forward between views, and router navigations into Orbit (/contacts, /companies, links…)
  useEffect(() => {
    const onPop = () => { if (window.location.pathname === "/orbit") apply(viewOf(new URLSearchParams(window.location.search).get("view"))); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [apply]);
  useEffect(() => { apply(urlView); }, [urlView, apply]);

  // ?new=1 (Quick create from any page, /contacts?new=1, /companies?new=1): the New panel straight away
  useEffect(() => {
    if (sp.get("new") !== "1") return;
    open({ kind: asked === "companies" ? "company" : "contact" });
    const next = new URLSearchParams(sp);
    next.delete("new");
    const s = next.toString();
    navigate(`/orbit${s ? `?${s}` : ""}`, { replace: true, state: window.history.state?.usr ?? null });
  }, [sp]); // eslint-disable-line react-hooks/exhaustive-deps

  const host = useMemo<OrbitHost>(() => ({ onNew: (kind) => open({ kind }), refresh }), [refresh, open]);
  const onOpen = useCallback((kind: OrbitKind, id: string) => open({ kind, id }), [open]);
  const [navOpen, setNavOpen] = useState(false);
  const ctx = useMemo(() => ({ view, views, go, navOpen, setNavOpen }), [view, views, go, navOpen]);
  const close = () => setPanel(null);
  const saved = () => setRefresh((x) => x + 1);
  const only = panel && {
    id: panel.id,
    draft: panel.draft,
    swapped: panel.swapped,
    onClose: close,
    onSaved: saved,
    onSwitch: (kind: OrbitKind, draft: OrbitDraft) => open({ kind, draft, swapped: true }),
  };
  const stateOf = (v: OrbitView) => (v === view ? (move ? "is-on is-in" : "is-on") : move?.from === v ? "is-out" : "is-idle");

  return (
    <OrbitViewContext.Provider value={ctx}>
      <div className="ob-stage" style={{ "--dir": move?.dir ?? 1 } as CSSProperties}>
        {views.filter((v) => mounted.includes(v)).map((v) => (
          <div key={v} className={`ob-pane ${stateOf(v)}`} aria-hidden={v !== view} inert={v !== view}>
            <Pane v={v} host={host} onOpen={onOpen} />
          </div>
        ))}
      </div>
      {panel && only && (panel.kind === "contact"
        ? <ContactsPage key={`panel-${panel.n}`} only={only} />
        : <CompaniesPage key={`panel-${panel.n}`} only={only} />)}
    </OrbitViewContext.Provider>
  );
}
