/**
 * BASE · Growth › Website — the public page visitors see. No sign-in.
 * Works at /w/<slug>/<page> on the app, and at <slug>.<VITE_SITES_DOMAIN>/<page> once that
 * wildcard domain points to the app (the kernel router mounts this component for both —
 * see src/base/TIERS.md §8). Reads only the published copy (rpc public_site, sql/160).
 */
import { useEffect, useState } from "react";
import SiteRender from "./SiteRender";
import { loadPublicSite } from "./siteApi";
import { SITES_DOMAIN, type Seo, type Site } from "./siteTypes";

/** The site a URL is for: <slug>.<sites domain>/<page> or /w/<slug>/<page>. */
export function siteFromLocation(loc: Location = window.location): { slug: string; path: string; base: string } | null {
  const host = loc.hostname.toLowerCase();
  if (SITES_DOMAIN && host.endsWith(`.${SITES_DOMAIN.toLowerCase()}`)) {
    const slug = host.slice(0, -(SITES_DOMAIN.length + 1));
    if (slug && !slug.includes(".")) return { slug, path: loc.pathname.replace(/^\/+|\/+$/g, ""), base: "" };
  }
  const m = loc.pathname.match(/^\/w\/([a-z0-9-]+)\/?(.*)$/i);
  if (m) return { slug: m[1].toLowerCase(), path: m[2].replace(/\/+$/g, ""), base: `/w/${m[1].toLowerCase()}` };
  return null;
}

function setMeta(name: string, content: string, prop = false) {
  const sel = prop ? `meta[property="${name}"]` : `meta[name="${name}"]`;
  let el = document.head.querySelector<HTMLMetaElement>(sel);
  if (!el) { el = document.createElement("meta"); el.setAttribute(prop ? "property" : "name", name); document.head.appendChild(el); }
  el.content = content;
}

export default function SitePublic({ slug: slugProp }: { slug?: string }) {
  const where = siteFromLocation();
  const slug = slugProp ?? where?.slug ?? "";
  const base = where?.base ?? `/w/${slug}`;
  const [data, setData] = useState<{ site: Site; seo: Seo; name: string } | null | undefined>(undefined);
  const [path, setPath] = useState(where?.path ?? "");
  useEffect(() => {
    let off = false;
    void loadPublicSite(slug).then((d) => { if (!off) setData(d); });
    return () => { off = true; };
  }, [slug]);
  useEffect(() => {
    const pop = () => setPath(siteFromLocation()?.path ?? "");
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  const page = data?.site.pages.find((p) => p.path === path) ?? data?.site.pages[0];
  useEffect(() => {
    if (!data || !page) return;
    const t = page.path ? `${page.title} · ${data.seo.title || data.name}` : data.seo.title || data.name;
    document.title = t;
    document.documentElement.lang = data.seo.lang || "en";
    setMeta("description", page.description || data.seo.description);
    if (data.seo.keywords.length) setMeta("keywords", data.seo.keywords.join(", "));
    setMeta("og:title", t, true);
    setMeta("og:description", page.description || data.seo.description, true);
    setMeta("og:type", "website", true);
    if (data.seo.og_image) setMeta("og:image", data.seo.og_image, true);
    document.body.style.margin = "0";
  }, [data, page]);

  if (data === undefined) return null;
  if (!data || !page) return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", fontFamily: "Inter, system-ui, sans-serif", color: "#5d6f66", textAlign: "center", padding: 24 }}>
      <div><div style={{ fontSize: 56, fontWeight: 800, color: "#0e1d17", letterSpacing: "-0.04em" }}>404</div><p>This website isn't online.</p></div>
    </div>
  );
  return (
    <SiteRender site={data.site} pageId={page.id}
      onNavigate={(p) => {
        const target = data.site.pages.find((x) => x.path === p);
        if (!target) return;
        window.history.pushState({}, "", `${base}${p ? `/${p}` : ""}` || "/");
        setPath(p);
        window.scrollTo({ top: 0 });
      }} />
  );
}
