/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * BASE · Growth › Website — draws a site (siteTypes.Site): the editor's live preview
 * and the public page use this same component, so what you see is what goes live.
 * Responsive by container queries (the preview's phone / tablet / desktop widths work
 * without resizing the window). Scoped under .ws-site so it never styles the app.
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { Section, Site, SitePage } from "./siteTypes";
import "./SiteRender.css";

/* ---- fonts: loaded once from Google Fonts when a site uses them ---- */
const FONT_Q: Record<string, string> = {
  Inter: "Inter:wght@400;500;600;700;800", "Space Grotesk": "Space+Grotesk:wght@500;600;700", Manrope: "Manrope:wght@400;500;600;700;800",
  "DM Serif Display": "DM+Serif+Display", "Playfair Display": "Playfair+Display:wght@500;600;700;800", Fraunces: "Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700",
  Outfit: "Outfit:wght@400;500;600;700;800", Sora: "Sora:wght@400;500;600;700;800", "DM Sans": "DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700",
  "Source Serif 4": "Source+Serif+4:opsz,wght@8..60,400;8..60,600",
};
const loaded = new Set<string>();
export function ensureFonts(fonts: string[]) {
  if (typeof document === "undefined") return;
  fonts.filter((f) => FONT_Q[f] && !loaded.has(f)).forEach((f) => {
    loaded.add(f);
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = `https://fonts.googleapis.com/css2?family=${FONT_Q[f]}&display=swap`;
    document.head.appendChild(l);
  });
}
const serif = (f: string) => /Serif|Playfair|Fraunces/.test(f);

/* ---- icons ---- */
const ICON_PATHS: Record<string, string> = {
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8",
  shield: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z M9 12l2 2 4-4",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  heart: "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z",
  leaf: "M11 20A7 7 0 0 1 4 13c0-6 7-10 16-10 0 9-4 16-10 16zM4 20c4-5 7-7 11-9",
  bolt: "M13 2L3 14h9l-1 8 10-12h-9z",
  star: "M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z",
  check: "M20 6L9 17l-5-5",
  rocket: "M5 15c-1.5 1.3-2 4-2 6 2 0 4.7-.5 6-2M12 15l-3-3M9 12c1-4 4.5-8 11-9-1 6.5-5 10-9 11zM15 9h.01",
  chat: "M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z",
  tool: "M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z",
  home: "M3 10.5L12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z",
  truck: "M3 6h11v10H3zM14 10h4l3 3v3h-7zM7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  book: "M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z",
  camera: "M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  coffee: "M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM17 10h1.5a2.5 2.5 0 0 1 0 5H17M8 3v3M12 3v3",
  code: "M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16",
  lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
  map: "M9 4L3 6v14l6-2 6 2 6-2V4l-6 2zM9 4v14M15 6v14",
  phone: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z",
  mail: "M3 5h18v14H3zM3 6l9 7 9-7",
  cart: "M3 4h2l2.7 11.4a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 2-1.5L21 8H6M10 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM18 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  gift: "M4 11h16v10H4zM3 7h18v4H3zM12 7v14M12 7S10.5 3 8 3a2 2 0 0 0 0 4M12 7s1.5-4 4-4a2 2 0 0 1 0 4",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01",
  award: "M12 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM8.2 13.9L7 22l5-3 5 3-1.2-8.1",
  layers: "M12 2l10 5-10 5L2 7zM2 17l10 5 10-5M2 12l10 5 10-5",
};
export const SiteIcon = ({ name, size = 22 }: { name: string; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICON_PATHS[name] ?? ICON_PATHS.spark} /></svg>
);
const SOCIAL: Record<string, string> = {
  linkedin: "M4 9h4v11H4zM6 3.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM10 9h3.8v1.6c.6-1 1.9-1.9 3.8-1.9 4 0 4.4 2.6 4.4 6V20h-4v-4.8c0-1.2 0-2.7-1.7-2.7s-2.3 1.3-2.3 2.6V20h-4z",
  instagram: "M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM17.5 6.5h.01",
  facebook: "M14 8h3V4h-3a4 4 0 0 0-4 4v3H7v4h3v6h4v-6h3l1-4h-4V8z",
  x: "M4 4l16 16M20 4L4 20",
  youtube: "M22 8.5a3 3 0 0 0-2-2.1C18.2 6 12 6 12 6s-6.2 0-8 .4a3 3 0 0 0-2 2.1A31 31 0 0 0 2 12a31 31 0 0 0 0 3.5 3 3 0 0 0 2 2.1c1.8.4 8 .4 8 .4s6.2 0 8-.4a3 3 0 0 0 2-2.1 31 31 0 0 0 0-3.5 31 31 0 0 0 0-3.5zM10 15V9l5 3z",
  tiktok: "M16 3c.3 2.3 1.8 4 4 4.2v3.3a7.5 7.5 0 0 1-4-1.2V16a5 5 0 1 1-5-5v3.3a1.8 1.8 0 1 0 1.7 1.7V3z",
};

/* ---- a picture, or abstract art in the site's colours when there's none yet ---- */
function Art({ url, alt, seed = 0, className = "" }: { url?: string; alt?: string; seed?: number; className?: string }) {
  if (url) return <img className={`ws-img ${className}`} src={url} alt={alt ?? ""} loading="lazy" />;
  const r = (n: number) => ((Math.sin((seed + 1) * 9301 + n * 49297) + 1) / 2);
  return (
    <div className={`ws-img ws-art ${className}`} aria-hidden="true">
      <svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id={`wsg${seed}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="var(--w-primary)" /><stop offset="1" stopColor="var(--w-primary-2)" /></linearGradient>
        </defs>
        <rect width="400" height="300" fill={`url(#wsg${seed})`} />
        <circle cx={80 + r(1) * 240} cy={60 + r(2) * 160} r={70 + r(3) * 60} fill="var(--w-accent)" opacity="0.55" />
        <circle cx={60 + r(4) * 280} cy={80 + r(5) * 160} r={30 + r(6) * 40} fill="#fff" opacity="0.18" />
        <rect x={r(7) * 200} y={180 + r(8) * 60} width={160} height={160} rx={40} fill="#fff" opacity="0.1" transform={`rotate(${r(9) * 40 - 20} 200 150)`} />
      </svg>
    </div>
  );
}

const paras = (t: string) => String(t ?? "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
const isPlaceholder = (t: string) => /\[[^\]]+\]/.test(t ?? "");
/** text with [placeholders] marked so they stand out in the editor */
function T({ v, edit }: { v: string; edit?: boolean }) {
  if (!edit || !isPlaceholder(v)) return <>{v}</>;
  return <>{String(v).split(/(\[[^\]]+\])/g).map((p, i) => (/^\[.*\]$/.test(p) ? <mark key={i} className="ws-ph" title="Replace this with the real thing">{p}</mark> : p))}</>;
}

export interface RenderProps {
  site: Site;
  pageId?: string;
  /** the editor: sections can be picked */
  editing?: boolean;
  selected?: string | null;
  onSelect?: (sectionId: string) => void;
  /** another page of the site was clicked ("/about") */
  onNavigate?: (path: string) => void;
  className?: string;
  /** the editor's preview: no fixed header */
  contained?: boolean;
}

function Btn({ l, kind = "primary", go }: { l: { label: string; href: string }; kind?: "primary" | "ghost" | "light"; go: (href: string, e: React.MouseEvent) => void }) {
  if (!l?.label) return null;
  return <a className={`ws-btn is-${kind}`} href={l.href || "#"} onClick={(e) => go(l.href, e)}>{l.label}</a>;
}

function SectionView({ s, go, edit, i }: { s: Section; go: (href: string, e: React.MouseEvent) => void; edit?: boolean; i: number }) {
  const d = s.data;
  const head = (center = true) => (d.title || d.subtitle) ? (
    <header className={`ws-h ${center ? "is-center" : ""}`}>
      {d.title && <h2><T v={d.title} edit={edit} /></h2>}
      {d.subtitle && <p><T v={d.subtitle} edit={edit} /></p>}
    </header>
  ) : null;
  switch (s.type) {
    case "hero": {
      const split = d.layout === "split";
      return (
        <div className={`ws-hero ${split ? "is-split" : ""}`}>
          <div className="ws-hero-txt">
            {d.eyebrow && <span className="ws-eyebrow"><T v={d.eyebrow} edit={edit} /></span>}
            <h1><T v={d.title} edit={edit} /></h1>
            {d.subtitle && <p className="ws-lead"><T v={d.subtitle} edit={edit} /></p>}
            <div className="ws-row"><Btn l={d.cta} go={go} /><Btn l={d.cta2} kind="ghost" go={go} /></div>
          </div>
          {(split || d.image_url) && <Art url={d.image_url} seed={i + 3} className="ws-hero-art" />}
        </div>
      );
    }
    case "features":
      return (<>{head()}<div className="ws-grid" style={{ ["--cols" as string]: d.columns } as CSSProperties}>
        {(d.items ?? []).map((x: any, j: number) => (
          <div key={j} className="ws-card ws-feat"><span className="ws-ico"><SiteIcon name={x.icon} /></span><h3><T v={x.title} edit={edit} /></h3><p><T v={x.text} edit={edit} /></p></div>
        ))}
      </div></>);
    case "services":
      return (<>{head()}<div className="ws-grid" style={{ ["--cols" as string]: Math.min(3, Math.max(1, (d.items ?? []).length)) } as CSSProperties}>
        {(d.items ?? []).map((x: any, j: number) => (
          <div key={j} className="ws-card ws-svc">
            {x.image_url && <Art url={x.image_url} className="ws-svc-img" />}
            <div className="ws-svc-b"><h3><T v={x.title} edit={edit} /></h3><p><T v={x.text} edit={edit} /></p>{x.price && <b className="ws-price"><T v={x.price} edit={edit} /></b>}</div>
          </div>
        ))}
      </div></>);
    case "about":
      return (
        <div className="ws-split">
          <div>
            {d.title && <h2 className="ws-h2"><T v={d.title} edit={edit} /></h2>}
            {paras(d.text).map((p, j) => <p key={j} className="ws-p"><T v={p} edit={edit} /></p>)}
            {(d.points ?? []).length > 0 && <ul className="ws-points">{d.points.map((p: string, j: number) => <li key={j}><span><SiteIcon name="check" size={15} /></span><T v={p} edit={edit} /></li>)}</ul>}
          </div>
          <Art url={d.image_url} seed={i + 7} className="ws-about-art" />
        </div>
      );
    case "steps":
      return (<>{head()}<ol className="ws-steps">
        {(d.items ?? []).map((x: any, j: number) => <li key={j} className="ws-card"><span className="ws-step-n">{j + 1}</span><h3><T v={x.title} edit={edit} /></h3><p><T v={x.text} edit={edit} /></p></li>)}
      </ol></>);
    case "stats":
      return (<>{head()}<div className="ws-stats">
        {(d.items ?? []).map((x: any, j: number) => <div key={j}><b><T v={x.value} edit={edit} /></b><span><T v={x.label} edit={edit} /></span></div>)}
      </div></>);
    case "testimonials":
      return (<>{head()}<div className="ws-grid" style={{ ["--cols" as string]: Math.min(3, Math.max(1, (d.items ?? []).length)) } as CSSProperties}>
        {(d.items ?? []).map((x: any, j: number) => (
          <figure key={j} className="ws-card ws-quote"><span className="ws-q">“</span><blockquote><T v={x.quote} edit={edit} /></blockquote>
            <figcaption><span className="ws-av">{(x.name || "?").replace(/[[\]]/g, "").slice(0, 1)}</span><span><b><T v={x.name} edit={edit} /></b><em><T v={x.role} edit={edit} /></em></span></figcaption></figure>
        ))}
      </div></>);
    case "pricing":
      return (<>{head()}<div className="ws-grid ws-plans" style={{ ["--cols" as string]: Math.max(1, (d.plans ?? []).length) } as CSSProperties}>
        {(d.plans ?? []).map((x: any, j: number) => (
          <div key={j} className={`ws-card ws-plan ${x.highlight ? "is-hi" : ""}`}>
            {x.highlight && <span className="ws-tag">Most popular</span>}
            <h3><T v={x.name} edit={edit} /></h3>
            <div className="ws-plan-p"><b><T v={x.price} edit={edit} /></b><em>{x.period}</em></div>
            <ul>{(x.features ?? []).map((f: string, k: number) => <li key={k}><SiteIcon name="check" size={15} /><T v={f} edit={edit} /></li>)}</ul>
            <Btn l={x.cta} kind={x.highlight ? "primary" : "ghost"} go={go} />
          </div>
        ))}
      </div></>);
    case "faq":
      return (<>{head()}<div className="ws-faq">{(d.items ?? []).map((x: any, j: number) => <Faq key={j} q={x.q} a={x.a} edit={edit} open={j === 0} />)}</div></>);
    case "gallery":
      return (<>{head()}<div className="ws-gal">{(d.images ?? []).length ? d.images.map((x: any, j: number) => <figure key={j}><Art url={x.url} seed={j} />{x.caption && <figcaption>{x.caption}</figcaption>}</figure>) : [0, 1, 2].map((j) => <figure key={j}><Art seed={j} /></figure>)}</div></>);
    case "logos":
      return (<>{head()}<div className="ws-logos">{(d.items ?? []).map((x: any, j: number) => x.logo_url ? <img key={j} src={x.logo_url} alt={x.name} /> : <span key={j}><T v={x.name} edit={edit} /></span>)}</div></>);
    case "cta":
      return (
        <div className="ws-cta">
          <div><h2><T v={d.title} edit={edit} /></h2>{d.text && <p><T v={d.text} edit={edit} /></p>}</div>
          <Btn l={d.cta} kind="light" go={go} />
        </div>
      );
    case "contact":
      return (
        <div className="ws-split ws-contact">
          <div>
            {d.title && <h2 className="ws-h2"><T v={d.title} edit={edit} /></h2>}
            {d.text && <p className="ws-p"><T v={d.text} edit={edit} /></p>}
            <ul className="ws-cl">
              {d.email && <li><span><SiteIcon name="mail" size={18} /></span><a href={`mailto:${d.email}`}>{d.email}</a></li>}
              {d.phone && <li><span><SiteIcon name="phone" size={18} /></span><a href={`tel:${d.phone.replace(/\s/g, "")}`}>{d.phone}</a></li>}
              {d.address && <li><span><SiteIcon name="map" size={18} /></span>{d.address}</li>}
              {d.hours && <li><span><SiteIcon name="clock" size={18} /></span>{d.hours}</li>}
            </ul>
          </div>
          {d.form_token
            ? <iframe className="ws-form" title="Contact form" src={`${typeof window !== "undefined" ? window.location.origin : ""}/f/${d.form_token}?embed=1`} loading="lazy" />
            : <div className="ws-card ws-form-ph">{edit ? <><b>Add a form</b><span>Pick one of your Growth › Forms for this section and visitors' answers land in your contacts.</span></> : <><b>Write to us</b>{d.email && <a className="ws-btn is-primary" href={`mailto:${d.email}`}>Send an e-mail</a>}</>}</div>}
        </div>
      );
    case "text":
      return (<div className="ws-text">{d.title && <h2 className="ws-h2"><T v={d.title} edit={edit} /></h2>}{paras(d.body).map((p, j) => <p key={j} className="ws-p"><T v={p} edit={edit} /></p>)}</div>);
  }
}

function Faq({ q, a, edit, open: o }: { q: string; a: string; edit?: boolean; open?: boolean }) {
  const [open, setOpen] = useState(!!o);
  return (
    <div className={`ws-faq-i ${open ? "is-open" : ""}`}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}><T v={q} edit={edit} /><i>+</i></button>
      <div className="ws-faq-a"><div><p><T v={a} edit={edit} /></p></div></div>
    </div>
  );
}

/** the theme as CSS variables (a second shade of the primary for gradients) */
export function themeVars(site: Site): CSSProperties {
  const t = site.theme;
  const fh = serif(t.font_heading) ? `"${t.font_heading}", Georgia, serif` : `"${t.font_heading}", system-ui, sans-serif`;
  const fb = serif(t.font_body) ? `"${t.font_body}", Georgia, serif` : `"${t.font_body}", system-ui, sans-serif`;
  return {
    ["--w-primary" as string]: t.primary, ["--w-primary-2" as string]: `color-mix(in srgb, ${t.primary} 70%, #000)`,
    ["--w-accent" as string]: t.accent, ["--w-bg" as string]: t.bg, ["--w-surface" as string]: t.surface,
    ["--w-text" as string]: t.text, ["--w-muted" as string]: t.muted, ["--w-r" as string]: `${t.radius}px`,
    ["--w-fh" as string]: fh, ["--w-fb" as string]: fb,
  } as CSSProperties;
}

export default function SiteRender({ site, pageId, editing, selected, onSelect, onNavigate, className = "", contained }: RenderProps) {
  useEffect(() => { ensureFonts([site.theme.font_heading, site.theme.font_body]); }, [site.theme.font_heading, site.theme.font_body]);
  const page: SitePage = site.pages.find((p) => p.id === pageId) ?? site.pages[0];
  const [menu, setMenu] = useState(false);
  const vars = useMemo(() => themeVars(site), [site]);
  const go = (href: string, e: React.MouseEvent) => {
    if (!href) { e.preventDefault(); return; }
    if (/^(https?:|mailto:|tel:)/i.test(href)) { if (editing) e.preventDefault(); return; }
    e.preventDefault();
    setMenu(false);
    const [path, hash] = href.split("#");
    const target = path.replace(/^\/+|\/+$/g, "");
    const sameOrHome = !path || target === page.path;
    if (!sameOrHome) onNavigate?.(target);
    if (hash) {
      const root = (e.currentTarget as HTMLElement).closest(".ws-site");
      window.setTimeout(() => root?.querySelector(`[data-sid="${CSS.escape(hash)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }), sameOrHome ? 0 : 120);
    }
  };
  const f = site.footer;
  const wrap = (s: Section, i: number, body: ReactNode) => (
    <section key={s.id} id={editing ? undefined : s.id} data-sid={s.id}
      className={`ws-sec is-${s.type} bg-${s.bg} ${editing ? "is-edit" : ""} ${selected === s.id ? "is-sel" : ""}`}
      onClickCapture={editing ? (e) => { const a = (e.target as HTMLElement).closest("a,button,iframe"); if (a && !(a as HTMLElement).closest(".ws-faq-i")) e.preventDefault(); onSelect?.(s.id); } : undefined}
      style={{ ["--i" as string]: i } as CSSProperties}>
      <div className="ws-in">{body}</div>
      {editing && <span className="ws-sec-tag">{s.type}</span>}
    </section>
  );
  return (
    <div className={`ws-site ${site.theme.mode === "dark" ? "is-dark" : ""} ${contained ? "is-contained" : ""} ${className}`} style={vars}>
      <header className="ws-nav">
        <div className="ws-in ws-nav-in">
          <a className="ws-brand" href="/" onClick={(e) => go("/", e)}>
            {site.brand.logo_url ? <img src={site.brand.logo_url} alt={site.brand.name} /> : <span className="ws-mark">{(site.brand.name || "·").slice(0, 1)}</span>}
            <b>{site.brand.name}</b>
          </a>
          <nav className={`ws-links ${menu ? "is-open" : ""}`}>
            {site.nav.links.map((l, i) => <a key={i} href={l.href || "#"} onClick={(e) => go(l.href, e)}>{l.label}</a>)}
            {site.nav.cta.label && <a className="ws-btn is-primary is-sm" href={site.nav.cta.href || "#"} onClick={(e) => go(site.nav.cta.href, e)}>{site.nav.cta.label}</a>}
          </nav>
          <button type="button" className="ws-burger" aria-label="Menu" onClick={() => setMenu((v) => !v)}><i /><i /><i /></button>
        </div>
      </header>
      <main>
        {page.sections.map((s, i) => wrap(s, i, <SectionView s={s} go={go} edit={editing} i={i} />))}
        {editing && !page.sections.length && <div className="ws-empty">This page has no sections yet — add one on the left, or ask the AI.</div>}
      </main>
      <footer className="ws-foot">
        <div className="ws-in ws-foot-in">
          <div className="ws-foot-a">
            <b>{site.brand.name}</b>
            {site.brand.tagline && <p>{site.brand.tagline}</p>}
            {f.socials.length > 0 && <div className="ws-socials">{f.socials.map((s, i) => <a key={i} href={s.url} target="_blank" rel="noreferrer" aria-label={s.network} onClick={(e) => editing && e.preventDefault()}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={SOCIAL[s.network] ?? ICON_PATHS.globe} /></svg></a>)}</div>}
          </div>
          {(site.pages.length > 1 || f.links.length > 0) && (
            <div className="ws-foot-l">
              {site.pages.map((p) => <a key={p.id} href={`/${p.path}`} onClick={(e) => go(`/${p.path}`, e)}>{p.title}</a>)}
              {f.links.map((l, i) => <a key={`l${i}`} href={l.href || "#"} onClick={(e) => go(l.href, e)}>{l.label}</a>)}
            </div>
          )}
          {(f.email || f.phone || f.address) && (
            <div className="ws-foot-c">
              {f.email && <a href={`mailto:${f.email}`}>{f.email}</a>}
              {f.phone && <span>{f.phone}</span>}
              {f.address && <span>{f.address}</span>}
            </div>
          )}
        </div>
        <div className="ws-in ws-foot-b"><span>{f.text || `© ${new Date().getFullYear()} ${site.brand.name}`}</span></div>
      </footer>
    </div>
  );
}
