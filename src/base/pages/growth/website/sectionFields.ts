/**
 * BASE · Growth › Website — the fields the editor shows for each kind of section
 * (what's in Section.data, see siteTypes.ts), so one generic form edits them all.
 */
import type { SectionType } from "./siteTypes";

export type FieldKind = "text" | "area" | "link" | "image" | "icon" | "select" | "list" | "strings" | "bool" | "form";
export interface FieldDef {
  k: string; label: string; kind: FieldKind;
  options?: { value: string; label: string }[];
  /** list: the fields of one item, and how a new item starts */
  item?: FieldDef[]; blank?: Record<string, unknown>; noun?: string;
  hint?: string;
}

const title: FieldDef = { k: "title", label: "Title", kind: "text" };
const subtitle: FieldDef = { k: "subtitle", label: "Line under the title", kind: "area" };

export const FIELDS: Record<SectionType, FieldDef[]> = {
  hero: [
    { k: "eyebrow", label: "Small label above", kind: "text" },
    { k: "title", label: "Headline", kind: "area" },
    { k: "subtitle", label: "Line under it", kind: "area" },
    { k: "cta", label: "Main button", kind: "link" },
    { k: "cta2", label: "Second button", kind: "link" },
    { k: "layout", label: "Layout", kind: "select", options: [{ value: "center", label: "Centred" }, { value: "split", label: "Text and picture side by side" }] },
    { k: "image_url", label: "Picture", kind: "image" },
  ],
  features: [title, subtitle,
    { k: "columns", label: "Columns", kind: "select", options: [{ value: "2", label: "2" }, { value: "3", label: "3" }, { value: "4", label: "4" }] },
    { k: "items", label: "Features", kind: "list", noun: "feature", blank: { icon: "spark", title: "New feature", text: "" }, item: [{ k: "icon", label: "Icon", kind: "icon" }, { k: "title", label: "Title", kind: "text" }, { k: "text", label: "Text", kind: "area" }] },
  ],
  services: [title, subtitle,
    { k: "items", label: "Services", kind: "list", noun: "service", blank: { title: "New service", text: "", price: "", image_url: "" }, item: [{ k: "title", label: "Name", kind: "text" }, { k: "text", label: "Description", kind: "area" }, { k: "price", label: "Price (optional)", kind: "text" }, { k: "image_url", label: "Picture", kind: "image" }] },
  ],
  about: [title, { k: "text", label: "Text (a blank line starts a new paragraph)", kind: "area" }, { k: "points", label: "Ticked points", kind: "strings", noun: "point" }, { k: "image_url", label: "Picture", kind: "image" }],
  steps: [title, subtitle,
    { k: "items", label: "Steps", kind: "list", noun: "step", blank: { title: "New step", text: "" }, item: [{ k: "title", label: "Title", kind: "text" }, { k: "text", label: "Text", kind: "area" }] },
  ],
  stats: [title,
    { k: "items", label: "Figures", kind: "list", noun: "figure", blank: { value: "[Number]", label: "" }, hint: "Only real figures — replace every [Number].", item: [{ k: "value", label: "Figure", kind: "text" }, { k: "label", label: "What it counts", kind: "text" }] },
  ],
  testimonials: [title, subtitle,
    { k: "items", label: "Quotes", kind: "list", noun: "quote", blank: { quote: "[A sentence from a real client]", name: "[Client name]", role: "" }, hint: "Only quotes from real clients, with their permission.", item: [{ k: "quote", label: "What they said", kind: "area" }, { k: "name", label: "Name", kind: "text" }, { k: "role", label: "Role, company", kind: "text" }] },
  ],
  pricing: [title, subtitle,
    { k: "plans", label: "Plans", kind: "list", noun: "plan", blank: { name: "Plan", price: "€", period: "/month", features: [], cta: { label: "Choose", href: "#contact" }, highlight: false }, item: [
      { k: "name", label: "Name", kind: "text" }, { k: "price", label: "Price", kind: "text" }, { k: "period", label: "Per", kind: "text" },
      { k: "features", label: "What's included", kind: "strings", noun: "line" }, { k: "cta", label: "Button", kind: "link" }, { k: "highlight", label: "Highlight this plan", kind: "bool" },
    ] },
  ],
  faq: [title, subtitle,
    { k: "items", label: "Questions", kind: "list", noun: "question", blank: { q: "New question", a: "" }, item: [{ k: "q", label: "Question", kind: "text" }, { k: "a", label: "Answer", kind: "area" }] },
  ],
  gallery: [title, subtitle,
    { k: "images", label: "Pictures", kind: "list", noun: "picture", blank: { url: "", caption: "" }, item: [{ k: "url", label: "Picture", kind: "image" }, { k: "caption", label: "Caption", kind: "text" }] },
  ],
  logos: [title,
    { k: "items", label: "Logos", kind: "list", noun: "logo", blank: { name: "", logo_url: "" }, item: [{ k: "name", label: "Name", kind: "text" }, { k: "logo_url", label: "Logo", kind: "image" }] },
  ],
  cta: [title, { k: "text", label: "Text", kind: "area" }, { k: "cta", label: "Button", kind: "link" }],
  contact: [title, { k: "text", label: "Text", kind: "area" },
    { k: "email", label: "E-mail", kind: "text" }, { k: "phone", label: "Phone", kind: "text" }, { k: "address", label: "Address", kind: "area" }, { k: "hours", label: "Opening hours", kind: "text" },
    { k: "form_token", label: "Form (Growth › Forms)", kind: "form", hint: "Answers become contacts in Orbit, like any of your forms." },
  ],
  text: [title, { k: "body", label: "Text (a blank line starts a new paragraph)", kind: "area" }],
};
