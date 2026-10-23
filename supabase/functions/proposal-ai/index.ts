import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/* =====================================================================
   proposal-ai — turns an imported proposal / contract into a template.
   POST { kind, lang, provider, items[], pages[], vars[], catalog, model? }
   Returns { plan: { replacements[], sections[], notes }, model }.
   POST { action: "extract_contract", text, model? }
   Returns { fields: {...order form fields}, model } — reads a signed contract.
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
  action?: "plan" | "extract_contract"; text?: string;
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
