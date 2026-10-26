import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/* =====================================================================
   proposal-ai — turns an imported proposal / contract into a template.
   POST { kind, lang, provider, items[], pages[], vars[], catalog, model? }
   Returns { plan: { replacements[], sections[], notes }, model }.
   POST { action: "extract_contract", text, model? }
   Returns { fields: {...order form fields}, model } — reads a signed contract.
   POST { action: "marketing_write", kind: "email" | "posts", brief, … }
   Returns { email | posts, model } — writes campaign e-mails and social posts.
   Only text goes to the model (no pictures, no files).
   Secrets: ANTHROPIC_API_KEY (required), PROPOSAL_AI_MODEL (optional).
   ===================================================================== */

const URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const DEFAULT_MODEL = Deno.env.get("PROPOSAL_AI_MODEL") || "claude-sonnet-5-5";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

interface Item { id: string; page: number; text: string; size?: number; role?: string }
interface Page { page: number; title?: string }
interface Body {
  action?: "plan" | "extract_contract" | "marketing_write"; text?: string;
  kind?: "proposal" | "contract"; lang?: "es" | "en"; provider?: string; model?: string;
  items?: Item[]; pages?: Page[]; vars?: { key: string; label: string; example?: string }[];
  catalog?: { products?: string[]; services?: string[] };
}

const TOOL = {
  name: "template_plan",
  description: "The plan that turns this one-off document into a reusable template.",
  input_schema: {
    type: "object",
    properties: {
      replacements: {
        type: "array",
        description: "Deal-specific text to replace. Each `find` must be an exact substring of that item's text.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "The item id." },
            find: { type: "string", description: "Exact substring of the item's text (as short as possible, but unique in the item)." },
            token: { type: "string", description: "A variable key from the list, when the text is a value of the deal (client name, date, price, contact…)." },
            text: { type: "string", description: "Instead of a token: corrected / generic wording (e.g. a typo, a leftover from another client)." },
            reason: { type: "string", description: "Why, in a few words (English)." },
          },
          required: ["id", "find", "reason"],
        },
      },
      sections: {
        type: "array",
        description: "Pages that only apply when the deal has given products or services (e.g. a page describing one product).",
        items: {
          type: "object",
          properties: {
            page: { type: "integer" },
            when: { type: "string", enum: ["always", "product", "service"] },
            names: { type: "array", items: { type: "string" }, description: "Names from the catalog this page is about." },
            reason: { type: "string" },
          },
          required: ["page", "when", "reason"],
        },
      },
      notes: { type: "string", description: "One or two sentences for the user (English)." },
    },
    required: ["replacements", "sections"],
  },
};

function prompt(b: Body): string {
  const items = (b.items ?? []).map((i) => `[${i.id}] (p${i.page}${i.role ? `, ${i.role}` : ""}${i.size ? `, ${Math.round(i.size)}px` : ""}) ${i.text}`);
  let list = items.join("\n");
  if (list.length > 60000) list = list.slice(0, 60000) + "\n…(truncated)";
  const vars = (b.vars ?? []).map((v) => `${v.key} — ${v.label}${v.example ? ` (e.g. ${v.example})` : ""}`).join("\n");
  const prods = (b.catalog?.products ?? []).join(" | ") || "(none)";
  const servs = (b.catalog?.services ?? []).join(" | ") || "(none)";
  const pages = (b.pages ?? []).map((p) => `p${p.page}: ${p.title ?? ""}`).join("\n");
  return `You turn a ${b.kind === "contract" ? "contract" : "commercial proposal"} written for ONE client into a reusable template.
The author (our company) is "${b.provider || "unknown"}" — its own name, products and claims stay as they are.
Language of the document: ${b.lang === "en" ? "English" : "Spanish"}.

Replace with a variable every value that belongs to THIS deal and will differ in the next one:
the client's name (and its legal name, group, abbreviations), contact names / roles / emails / phones of the client,
dates of the offer, validity dates, prices, discounts, totals, numbers of companies/users when they describe the client,
the seller's name / phone / email when a variable exists for it. Never tokenise our company, product names, generic claims,
reference customers/testimonials of other companies, section numbers or headings.
Use ONLY keys from the variable list. Keep \`find\` exact (copy it from the item text) and minimal.
Text already containing {{…}} is already a variable: leave it.
If something is clearly a leftover of another client or a typo, you may give \`text\` instead of \`token\`.

Sections: when a page is specific to one product or service of the catalog (e.g. "Licencia Suite", "Data Management"),
give when=product/service and the catalog names. Pages valid for every deal: do not list them.

Variables:
${vars}

Catalog products: ${prods}
Catalog services: ${servs}

Pages:
${pages}

Texts (id, page, role/size, text):
${list}`;
}

const S = { type: "string" }, N = { type: "number" }, B = { type: "boolean" };
const PERSON = { type: "object", properties: { name: S, email: S, phone: S, role: S } };
const EXTRACT_TOOL = {
  name: "contract_fields",
  description: "The data written in this signed contract / order form. Leave out anything that isn't written in it.",
  input_schema: {
    type: "object",
    properties: {
      ref: { type: "string", description: "Contract / order form number." },
      customer: { type: "object", properties: { legalName: S, regNo: S, vat: S, address: S, country: S } },
      contactPerson: PERSON,
      adminUser: { type: "object", properties: { name: S, email: S } },
      lines: { type: "array", items: { type: "object", properties: { name: S, list: { type: "number", description: "List price per unit" }, final: { type: "number", description: "Price per unit after discount" }, discountPct: N, qty: N, oneTime: B }, required: ["name"] } },
      totals: { type: "object", properties: { oneTime: N, annualList: N, annualFinal: N } },
      currency: { type: "string", description: "ISO code, e.g. EUR" },
      pricesExclVat: B,
      paymentTermsDays: N,
      billingFrequency: { type: "string", enum: ["annually", "quarterly", "monthly", "upfront"] },
      termsUrl: S, newsletter: B, marketingConsent: B,
      contractStart: { type: "string", description: "YYYY-MM-DD" },
      nonTerminableYears: N, autoRenew: B, renewYears: N,
      increasePct: { type: "number", description: "Yearly price increase in %" },
      services: { type: "object", properties: { days: N, tolerancePct: N, billing: { type: "string", enum: ["per_day", "fixed"] }, roles: { type: "array", items: { type: "object", properties: { label: S, days: N, rate: N } } }, note: S } },
      signatories: { type: "array", items: { type: "object", properties: { side: { type: "string", enum: ["supplier", "customer"] }, name: S, role: S, email: S, phone: S }, required: ["side", "name"] } },
      signDate: { type: "string", description: "YYYY-MM-DD" },
      esignId: S, esignProvider: S,
    },
  },
};

async function extractContract(text: string, model: string): Promise<{ fields: unknown; model: string }> {
  const body = text.length > 60000 ? text.slice(0, 60000) + "\n…(truncated)" : text;
  const content = `This is the text of a signed contract / order form (columns separated by spaces). The supplier is the company selling the software subscription; the customer is the other party.
Return only what is written. Amounts as plain numbers. Dates as YYYY-MM-DD.

${body}`;
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 4000, tools: [EXTRACT_TOOL], tool_choice: { type: "tool", name: EXTRACT_TOOL.name }, messages: [{ role: "user", content }] }),
    });
    if (r.status === 429 || r.status >= 500) {
      last = `${r.status} ${await r.text().catch(() => "")}`.slice(0, 300);
      await new Promise((ok) => setTimeout(ok, Math.min(Number(r.headers.get("retry-after")) * 1000 || 1500 * 2 ** attempt, 12000)));
      continue;
    }
    const out = await r.json().catch(() => null);
    if (!r.ok) throw new Error(out?.error?.message ?? `Anthropic API ${r.status}`);
    const use = (out?.content ?? []).find((c: any) => c.type === "tool_use" && c.name === EXTRACT_TOOL.name);
    if (use?.input && typeof use.input === "object") return { fields: use.input, model: out?.model ?? model };
    last = "The model gave no fields.";
  }
  throw new Error(last || "The model did not answer.");
}

async function callModel(b: Body, model: string): Promise<{ plan: unknown; model: string }> {
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model, max_tokens: 8000,
        tools: [TOOL], tool_choice: { type: "tool", name: TOOL.name },
        messages: [{ role: "user", content: prompt(b) }],
      }),
    });
    if (r.status === 429 || r.status >= 500) {
      last = `${r.status} ${await r.text().catch(() => "")}`.slice(0, 300);
      const wait = Number(r.headers.get("retry-after")) * 1000 || 1500 * 2 ** attempt;
      await new Promise((ok) => setTimeout(ok, Math.min(wait, 12000)));
      continue;
    }
    const out = await r.json().catch(() => null);
    if (!r.ok) throw new Error(out?.error?.message ?? `Anthropic API ${r.status}`);
    const use = (out?.content ?? []).find((c: any) => c.type === "tool_use" && c.name === TOOL.name);
    let plan = use?.input;
    if (!plan) {
      // a text answer: take the JSON in it
      const txt = (out?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      const m = txt.match(/\{[\s\S]*\}/);
      try { plan = m ? JSON.parse(m[0]) : null; } catch { plan = null; }
    }
    if (plan && typeof plan === "object") return { plan, model: out?.model ?? model };
    last = "The model gave no plan.";
  }
  throw new Error(last || "The model did not answer.");
}

/* ───────────── Marketing: e-mails and social posts ───────────── */
interface MkBody {
  kind?: "email" | "posts"; brief?: string; tone?: string; lang?: string; company?: string; audience?: string;
  goal?: string; cta?: string; link?: string; networks?: string[]; count?: number; from?: string; to?: string;
  fields?: string[]; current?: string; model?: string;
}
const MK_EMAIL_TOOL = {
  name: "email_draft",
  description: "A marketing e-mail ready to send.",
  input_schema: {
    type: "object",
    properties: {
      subject: { type: "string", description: "Short, specific, no clickbait, no ALL CAPS. May use merge fields like {{first_name}}." },
      subjects_alt: { type: "array", items: { type: "string" }, description: "Three other subject lines to A/B test." },
      preheader: { type: "string", description: "The preview line shown after the subject in the inbox (40-90 characters)." },
      body_html: { type: "string", description: "The body as simple HTML: <p>, <h2>, <ul><li>, <strong>, <a href>. No <html>/<body>, no styles, no images, no unsubscribe line (added automatically). Start with a greeting using {{first_name}}." },
    },
    required: ["subject", "preheader", "body_html"],
  },
};
const MK_POSTS_TOOL = {
  name: "social_posts",
  description: "A series of social media posts.",
  input_schema: {
    type: "object",
    properties: {
      posts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Internal name of the post, 2-6 words." },
            body: { type: "string", description: "The main text (LinkedIn style when LinkedIn is one of the networks)." },
            variants: { type: "object", description: "Text adapted to each requested network (key = network id). X: max 270 characters. Instagram: hook first line, hashtags at the end.", additionalProperties: { type: "string" } },
            hashtags: { type: "array", items: { type: "string" } },
            date: { type: "string", description: "YYYY-MM-DD within the requested period, spread out sensibly (weekdays, not two on the same day)." },
            time: { type: "string", description: "HH:MM local time, a good hour for B2B (08:00-10:00 or 12:00-14:00)." },
            image_idea: { type: "string", description: "One sentence describing a picture or carousel that would go with it." },
          },
          required: ["title", "body", "variants", "date", "time"],
        },
      },
    },
    required: ["posts"],
  },
};
const LIMITS: Record<string, string> = { linkedin: "LinkedIn (max 3000 chars, best 600-1300, line breaks, 3-5 hashtags)", instagram: "Instagram (max 2200 chars, hook in first line, emojis ok, up to 10 hashtags at the end)", facebook: "Facebook (best under 500 chars)", x: "X / Twitter (max 270 chars, 1-2 hashtags)", tiktok: "TikTok caption (max 2200, short)", threads: "Threads (max 500 chars)", youtube: "YouTube community post", other: "Other network" };
async function marketingWrite(b: MkBody, model: string): Promise<unknown> {
  const lang = b.lang === "en" ? "English" : b.lang === "ca" ? "Catalan" : "Spanish (Spain)";
  const isEmail = b.kind !== "posts";
  const nets = (b.networks ?? []).filter((n) => LIMITS[n]);
  const content = isEmail
    ? `Write a B2B marketing e-mail for ${b.company || "our company"}.
Language: ${lang}. Tone: ${b.tone || "professional and warm"}.
Audience: ${b.audience || "our contacts"}.
Goal: ${b.goal || "inform and start a conversation"}.
${b.cta ? `Call to action: ${b.cta}${b.link ? ` — link: ${b.link}` : ""}.` : b.link ? `Link to include: ${b.link}.` : ""}
Merge fields you may use (exactly like this): ${(b.fields ?? ["first_name", "company"]).map((f) => `{{${f}}}`).join(", ")}.
Keep it short (120-220 words), scannable, one clear call to action, no spammy words, no invented facts or figures.
${b.current ? `Improve this current draft instead of starting over:\n${String(b.current).slice(0, 8000)}\n` : ""}
Brief from the marketer:
${String(b.brief ?? "").slice(0, 6000)}`
    : `Plan and write ${Math.max(1, Math.min(30, Number(b.count) || 5))} social media posts for ${b.company || "our company"}.
Language: ${lang}. Tone: ${b.tone || "professional, human, insightful"}.
Networks: ${nets.map((n) => `${n} = ${LIMITS[n]}`).join("; ") || "linkedin = " + LIMITS.linkedin}.
Period: from ${b.from || "next Monday"} to ${b.to || "four weeks later"}.
Audience: ${b.audience || "B2B decision makers"}.
${b.link ? `Link to promote when it fits: ${b.link}.` : ""}
Vary the formats (insight, tip, question, case, behind the scenes, announcement). No invented facts, clients or figures.
Write a variant for EVERY requested network, keyed by its id.
Brief from the marketer:
${String(b.brief ?? "").slice(0, 6000)}`;
  const tool = isEmail ? MK_EMAIL_TOOL : MK_POSTS_TOOL;
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: isEmail ? 3000 : 8000, tools: [tool], tool_choice: { type: "tool", name: tool.name }, messages: [{ role: "user", content }] }),
    });
    if (r.status === 429 || r.status >= 500) {
      last = `${r.status} ${await r.text().catch(() => "")}`.slice(0, 300);
      await new Promise((ok) => setTimeout(ok, Math.min(Number(r.headers.get("retry-after")) * 1000 || 1500 * 2 ** attempt, 12000)));
      continue;
    }
    const out = await r.json().catch(() => null);
    if (!r.ok) throw new Error(out?.error?.message ?? `Anthropic API ${r.status}`);
    const use = (out?.content ?? []).find((c: any) => c.type === "tool_use" && c.name === tool.name);
    if (use?.input && typeof use.input === "object") return isEmail ? { email: use.input, model: out?.model ?? model } : { posts: (use.input as any).posts ?? [], model: out?.model ?? model };
    last = "The model gave no answer.";
  }
  throw new Error(last || "The model did not answer.");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const asUser = createClient(URL, ANON, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: u } = await asUser.auth.getUser();
    if (!u?.user) return json({ error: "Unauthorized" }, 401);
    if (!KEY) return json({ error: "no_key", message: "Set the ANTHROPIC_API_KEY secret to use AI suggestions." }, 501);
    const b = (await req.json()) as Body;
    const model0 = (typeof b.model === "string" && /^claude-[\w.-]+$/.test(b.model)) ? b.model : DEFAULT_MODEL;
    if (b.action === "marketing_write") {
      const mb = b as unknown as MkBody;
      if (!String(mb.brief ?? "").trim() && !String(mb.current ?? "").trim()) return json({ error: "Write a short brief first." }, 400);
      return json(await marketingWrite(mb, model0));
    }
    if (b.action === "extract_contract") {
      if (typeof b.text !== "string" || !b.text.trim()) return json({ error: "No text to read." }, 400);
      return json(await extractContract(b.text, model0));
    }
    if (!Array.isArray(b.items) || !b.items.length) return json({ error: "No texts to read." }, 400);
    const model = (typeof b.model === "string" && /^claude-[\w.-]+$/.test(b.model)) ? b.model : DEFAULT_MODEL;
    const r = await callModel(b, model);
    return json(r);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 502);
  }
});
