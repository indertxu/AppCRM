/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * BASE · Growth › Website — what a website is (the JSON kept in base_sites.draft,
 * sql/160) and how to clean whatever the AI sends back into exactly that shape.
 * The same shape is drawn by SiteRender (the editor's preview and the public page).
 */

export type SectionType =
  | "hero" | "features" | "services" | "about" | "steps" | "stats" | "testimonials"
  | "pricing" | "faq" | "gallery" | "logos" | "cta" | "contact" | "text";
export type SectionBg = "default" | "alt" | "primary" | "dark";
export interface Link { label: string; href: string }
export interface Section { id: string; type: SectionType; bg: SectionBg; data: Record<string, any> }
export interface SitePage { id: string; path: string; title: string; description: string; sections: Section[] }
export interface Theme {
  primary: string; accent: string; bg: string; surface: string; text: string; muted: string;
  font_heading: string; font_body: string; radius: number; mode: "light" | "dark";
}
export interface Site {
  theme: Theme;
  brand: { name: string; tagline: string; logo_url: string };
  nav: { links: Link[]; cta: Link };
  footer: { text: string; email: string; phone: string; address: string; links: Link[]; socials: { network: string; url: string }[] };
  pages: SitePage[];
}
export interface Seo { title: string; description: string; keywords: string[]; lang: string; og_image?: string }
export interface Brief { name: string; about: string; offer: string; audience: string; tone: string; colors: string; contact: string; lang: string; pages: string[]; extra: string }

export interface SiteRow {
  id: string; name: string; slug: string; status: "draft" | "live" | "paused";
  draft: Site; seo: Seo; settings: Record<string, any>; brief: Partial<Brief>;
  published: { site: Site; seo: Seo } | null; published_at: string | null;
  created_at: string; updated_at: string;
}
export interface SiteVersion { id: string; kind: string; note: string; created_at: string; draft: Site; seo: Seo }

export const HEADING_FONTS = ["Inter", "Space Grotesk", "Manrope", "DM Serif Display", "Playfair Display", "Fraunces", "Outfit", "Sora"];
export const BODY_FONTS = ["Inter", "Manrope", "DM Sans", "Outfit", "Source Serif 4"];
export const ICONS = ["spark", "shield", "clock", "chart", "users", "heart", "globe", "leaf", "bolt", "star", "check", "rocket", "chat", "tool", "home", "truck", "book", "camera", "coffee", "code", "lock", "map", "phone", "mail", "cart", "gift", "sun", "target", "award", "layers"] as const;

export const SECTION_INFO: Record<SectionType, { label: string; hint: string }> = {
  hero: { label: "Hero", hint: "The big first screen: headline, line and buttons" },
  features: { label: "Features", hint: "Reasons to choose you, with icons" },
  services: { label: "Services", hint: "What you sell, with prices if you like" },
  about: { label: "About", hint: "Who you are, with a picture" },
  steps: { label: "How it works", hint: "Numbered steps" },
  stats: { label: "Figures", hint: "A few numbers that matter" },
  testimonials: { label: "Testimonials", hint: "What real clients say" },
  pricing: { label: "Pricing", hint: "Plans side by side" },
  faq: { label: "FAQ", hint: "Questions and answers" },
  gallery: { label: "Gallery", hint: "Pictures" },
  logos: { label: "Logos", hint: "Clients or partners" },
  cta: { label: "Call to action", hint: "A strong band with one button" },
  contact: { label: "Contact", hint: "E-mail, phone, address and a form" },
  text: { label: "Text", hint: "A free block of text" },
};

export const DEFAULT_THEME: Theme = {
  primary: "#0c875f", accent: "#d6f46c", bg: "#ffffff", surface: "#f3f6f4", text: "#0e1d17", muted: "#5d6f66",
  font_heading: "Space Grotesk", font_body: "Inter", radius: 18, mode: "light",
};

/* ---------------------------------------------------------------- cleaning */
const str = (v: any, max = 4000): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "").slice(0, max);
const hex = (v: any, d: string) => (typeof v === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim()) ? v.trim() : d);
const arr = (v: any): any[] => (Array.isArray(v) ? v : []);
const link = (v: any): Link => ({ label: str(v?.label, 80), href: str(v?.href, 400) });
export const newId = (p = "s") => `${p}${Math.random().toString(36).slice(2, 8)}`;
const idOk = (v: any) => (typeof v === "string" && /^[\w-]{1,40}$/.test(v) ? v : "");
const pathOk = (v: any) => str(v, 60).toLowerCase().replace(/^\/+|\/+$/g, "").replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
const TYPES = Object.keys(SECTION_INFO) as SectionType[];
const BGS: SectionBg[] = ["default", "alt", "primary", "dark"];

function cleanData(type: SectionType, d: any): Record<string, any> {
  d = d && typeof d === "object" ? d : {};
  const base = { title: str(d.title, 300), subtitle: str(d.subtitle, 600) };
  switch (type) {
    case "hero": return { ...base, eyebrow: str(d.eyebrow, 120), cta: link(d.cta), cta2: link(d.cta2), image_url: str(d.image_url, 800), layout: d.layout === "split" ? "split" : "center" };
    case "features": return { ...base, columns: [2, 3, 4].includes(Number(d.columns)) ? Number(d.columns) : 3, items: arr(d.items).slice(0, 12).map((x) => ({ icon: (ICONS as readonly string[]).includes(x?.icon) ? x.icon : "spark", title: str(x?.title, 120), text: str(x?.text, 600) })) };
    case "services": return { ...base, items: arr(d.items).slice(0, 12).map((x) => ({ title: str(x?.title, 120), text: str(x?.text, 800), price: str(x?.price, 60), image_url: str(x?.image_url, 800) })) };
    case "about": return { ...base, text: str(d.text, 4000), points: arr(d.points).slice(0, 10).map((x) => str(x, 200)).filter(Boolean), image_url: str(d.image_url, 800) };
    case "steps": return { ...base, items: arr(d.items).slice(0, 8).map((x) => ({ title: str(x?.title, 120), text: str(x?.text, 600) })) };
    case "stats": return { ...base, items: arr(d.items).slice(0, 6).map((x) => ({ value: str(x?.value, 30), label: str(x?.label, 80) })) };
    case "testimonials": return { ...base, items: arr(d.items).slice(0, 9).map((x) => ({ quote: str(x?.quote, 700), name: str(x?.name, 80), role: str(x?.role, 120) })) };
    case "pricing": return { ...base, plans: arr(d.plans).slice(0, 4).map((x) => ({ name: str(x?.name, 60), price: str(x?.price, 40), period: str(x?.period, 40), features: arr(x?.features).slice(0, 12).map((f) => str(f, 160)).filter(Boolean), cta: link(x?.cta), highlight: !!x?.highlight })) };
    case "faq": return { ...base, items: arr(d.items).slice(0, 16).map((x) => ({ q: str(x?.q, 240), a: str(x?.a, 1500) })) };
    case "gallery": return { ...base, images: arr(d.images).slice(0, 24).map((x) => ({ url: str(x?.url, 800), caption: str(x?.caption, 200) })) };
    case "logos": return { ...base, items: arr(d.items).slice(0, 16).map((x) => ({ name: str(x?.name, 80), logo_url: str(x?.logo_url, 800) })) };
    case "cta": return { ...base, text: str(d.text, 600), cta: link(d.cta) };
    case "contact": return { ...base, text: str(d.text, 800), email: str(d.email, 160), phone: str(d.phone, 60), address: str(d.address, 300), hours: str(d.hours, 200), form_token: str(d.form_token, 80) };
    case "text": return { ...base, body: str(d.body, 8000) };
  }
}

export function cleanSection(s: any): Section | null {
  const type = TYPES.includes(s?.type) ? (s.type as SectionType) : null;
  if (!type) return null;
  return { id: idOk(s?.id) || newId(), type, bg: BGS.includes(s?.bg) ? s.bg : "default", data: cleanData(type, s?.data ?? s) };
}

/** Whatever came back (AI or database) as a valid site; ids made unique. */
export function cleanSite(raw: any, fallbackName = ""): Site {
  const t = raw?.theme ?? {};
  const seen = new Set<string>();
  const uniq = (id: string, p: string) => { let v = id || newId(p); while (seen.has(v)) v = newId(p); seen.add(v); return v; };
  const pages = arr(raw?.pages).slice(0, 12).map((p, i) => ({
    id: uniq(idOk(p?.id), "p"), path: i === 0 ? "" : pathOk(p?.path) || pathOk(p?.title) || `page-${i}`,
    title: str(p?.title, 120) || (i === 0 ? "Home" : `Page ${i + 1}`), description: str(p?.description, 300),
    sections: arr(p?.sections).slice(0, 30).map(cleanSection).filter((x): x is Section => !!x).map((s) => ({ ...s, id: uniq(s.id, "s") })),
  }));
  if (!pages.length) pages.push({ id: "home", path: "", title: "Home", description: "", sections: [] });
  // two pages can't share a path
  const paths = new Set<string>();
  pages.forEach((p, i) => { if (i === 0) { p.path = ""; return; } let q = p.path; let n = 2; while (paths.has(q) || !q) q = `${p.path || "page"}-${n++}`; p.path = q; paths.add(q); });
  return {
    theme: {
      primary: hex(t.primary, DEFAULT_THEME.primary), accent: hex(t.accent, DEFAULT_THEME.accent), bg: hex(t.bg, DEFAULT_THEME.bg),
      surface: hex(t.surface, DEFAULT_THEME.surface), text: hex(t.text, DEFAULT_THEME.text), muted: hex(t.muted, DEFAULT_THEME.muted),
      font_heading: HEADING_FONTS.includes(t.font_heading) ? t.font_heading : DEFAULT_THEME.font_heading,
      font_body: BODY_FONTS.includes(t.font_body) ? t.font_body : DEFAULT_THEME.font_body,
      radius: Number.isFinite(Number(t.radius)) ? Math.max(0, Math.min(28, Number(t.radius))) : DEFAULT_THEME.radius,
      mode: t.mode === "dark" ? "dark" : "light",
    },
    brand: { name: str(raw?.brand?.name, 80) || fallbackName, tagline: str(raw?.brand?.tagline, 160), logo_url: str(raw?.brand?.logo_url, 800) },
    nav: { links: arr(raw?.nav?.links).slice(0, 8).map(link).filter((l) => l.label), cta: link(raw?.nav?.cta) },
    footer: {
      text: str(raw?.footer?.text, 400), email: str(raw?.footer?.email, 160), phone: str(raw?.footer?.phone, 60), address: str(raw?.footer?.address, 300),
      links: arr(raw?.footer?.links).slice(0, 10).map(link).filter((l) => l.label),
      socials: arr(raw?.footer?.socials).slice(0, 8).map((x) => ({ network: str(x?.network, 20).toLowerCase(), url: str(x?.url, 400) })).filter((x) => x.url),
    },
    pages,
  };
}

export function cleanSeo(raw: any, site?: Site): Seo {
  return {
    title: str(raw?.title, 70) || site?.brand.name || "",
    description: str(raw?.description, 200),
    keywords: arr(raw?.keywords).slice(0, 15).map((k) => str(k, 40)).filter(Boolean),
    lang: str(raw?.lang, 8) || "en",
    og_image: str(raw?.og_image, 800),
  };
}

/** A new, empty section of a type, ready to fill in. */
export function blankSection(type: SectionType): Section {
  const s = cleanSection({ type, data: {} })!;
  const d = s.data;
  if (type === "hero") Object.assign(d, { title: "Your headline", subtitle: "One line on what you do and for whom.", cta: { label: "Get in touch", href: "#contact" } });
  if (type === "features") d.items = [1, 2, 3].map((n) => ({ icon: ICONS[n], title: `Reason ${n}`, text: "Say why it matters." }));
  if (type === "services") d.items = [1, 2, 3].map((n) => ({ title: `Service ${n}`, text: "What's included.", price: "", image_url: "" }));
  if (type === "steps") d.items = [1, 2, 3].map((n) => ({ title: `Step ${n}`, text: "What happens." }));
  if (type === "stats") d.items = [{ value: "[Number]", label: "Clients" }, { value: "[Number]", label: "Years" }, { value: "[Number]", label: "Projects" }];
  if (type === "testimonials") d.items = [{ quote: "[A sentence from a real client]", name: "[Client name]", role: "[Role, company]" }];
  if (type === "pricing") d.plans = [{ name: "Basic", price: "€", period: "/month", features: ["…"], cta: { label: "Choose", href: "#contact" }, highlight: false }, { name: "Pro", price: "€", period: "/month", features: ["…"], cta: { label: "Choose", href: "#contact" }, highlight: true }];
  if (type === "faq") d.items = [{ q: "A question people ask", a: "The answer." }];
  if (type === "cta") Object.assign(d, { title: "Ready to start?", text: "", cta: { label: "Contact us", href: "#contact" } });
  if (type === "contact") Object.assign(d, { title: "Contact", text: "Tell us what you need and we'll get back to you." });
  if (type === "about") Object.assign(d, { title: "About us", text: "Who you are and why you do it." });
  if (type === "text") Object.assign(d, { title: "Title", body: "Your text." });
  if (type !== "hero" && !d.title) d.title = SECTION_INFO[type].label;
  s.id = type === "contact" ? "contact" : newId();
  return s;
}

/** A first site to start from when the AI isn't used. */
export function starterSite(name: string): Site {
  return cleanSite({
    theme: DEFAULT_THEME,
    brand: { name, tagline: "" },
    nav: { links: [{ label: "About", href: "#about" }, { label: "Contact", href: "#contact" }], cta: { label: "Get in touch", href: "#contact" } },
    footer: { text: `© ${new Date().getFullYear()} ${name}` },
    pages: [{ id: "home", path: "", title: "Home", sections: [blankSection("hero"), { ...blankSection("about"), id: "about" }, blankSection("features"), blankSection("contact")] }],
  }, name);
}

/** "Acme Logistics, S.L." → "acme-logistics" */
export const slugify = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/\b(s\.?l\.?u?|s\.?a\.?u?|ltd|llc|inc|gmbh|b\.?v\.?)\b/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "my-site";
export const slugValid = (s: string) => /^[a-z0-9]([a-z0-9-]{1,46}[a-z0-9])?$/.test(s);

/** Where a site lives: <slug>.<VITE_SITES_DOMAIN> once that domain points here, else /w/<slug> on the app. */
export const SITES_DOMAIN: string = ((import.meta as any).env?.VITE_SITES_DOMAIN as string | undefined)?.trim() || "";
export const siteUrl = (slug: string) => (SITES_DOMAIN ? `https://${slug}.${SITES_DOMAIN}` : `${typeof window !== "undefined" ? window.location.origin : ""}/w/${slug}`);
export const siteHost = (slug: string) => (SITES_DOMAIN ? `${slug}.${SITES_DOMAIN}` : `${typeof window !== "undefined" ? window.location.host : ""}/w/${slug}`);
