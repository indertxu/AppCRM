// =====================================================================
// Supabase Edge Function: marketing-hub   (Enterprise · Marketing)
//
// Sends and publishes through the accounts people connected in
// Settings › Integrations (connected_accounts / connected_account_tokens,
// SQL 119 + 124 — the same rows Base's "connected-accounts" function keeps).
//
// Actions (POST):
//   mail_send     { accountId, to[], subject, html, from?, replyTo?, ref? }   caller's JWT
//                 One e-mail from one of the caller's own Gmail / Outlook accounts
//                 (Gmail API users.messages.send · Microsoft Graph /me/sendMail).
//                 "from" = another address of that mailbox (Gmail "Send mail as" alias,
//                 Microsoft 365 "Send as" / shared mailbox) — the provider checks it.
//   social_publish { postId }   caller's JWT
//                 Publishes the post's LinkedIn text now on the caller's LinkedIn profile
//                 (or the account the post names in auto_accounts.linkedin, when it is the caller's);
//                 auto_accounts.linkedin_as = a company page's number (connected_assets linkedin_org of that
//                 person's LinkedIn sign-in) → posted as the page (needs LinkedIn's Community Management API).
//   smtp_connect  { email, password, host?, port?, label? }   caller's JWT
//                 A mailbox reached by SMTP (IONOS Mail…): signs in once to check it, then keeps it
//                 (connected_accounts provider "smtp", settings {host, port, label} — SQL 145; the password
//                 in connected_account_tokens, read only here). No host: tries IONOS' servers.
//   smtp_check    { id }   signs in again (Settings › Integrations › Check now)
//   smtp_probe    { host }   reaches an IONOS SMTP server without signing in (network check)
//   link_meta     { url }   caller's JWT — the page's own preview (Open Graph: title, description, picture)
//   li_people     {}   caller's JWT — colleagues who connected LinkedIn (name + member URN), to @mention them
//   li_resolve    { ref }   caller's JWT — a LinkedIn company page (link, vanity name or number) → its name + URN,
//                 looked up with the caller's LinkedIn sign-in, to @mention it
//   (posts: marketing_posts.mentions [{name, urn}] become LinkedIn @mentions, #words LinkedIn hashtags,
//    and a link without a picture goes out as a link card with the page's own picture — SQL 146)
//   wf_due        {}   header x-cs-cron (pg_cron, SQL 149, every 5 min): marketing workflows move along
//   wf_run        { id }   caller's JWT — one active workflow now (just switched on / "Run now")
//   social_due    {}   header x-cs-cron = cs_cron_key.key (pg_cron, SQL 144, every 5 min)
//                 Publishes every scheduled post whose time has come and that names a
//                 LinkedIn account in auto_accounts.linkedin.
//
// Results go to marketing_posts.results.linkedin = { url, urn, auto_at } or { auto_error }.
// A post only for LinkedIn becomes "published"; with other networks it stays "scheduled"
// (Ready) so the rest are published by hand.
//
// Secrets (already set for connected-accounts): GOOGLE_CLIENT_ID / _SECRET, MS_CLIENT_ID / _SECRET.
// SMTP goes out on port 465 (implicit TLS); 587 (STARTTLS) is tried only when asked for.
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cs-cron",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const errMsg = (e: unknown) => String((e as Error)?.message ?? e);

async function caller(req: Request): Promise<{ id: string; tenant: string } | null> {
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  const { data: prof } = await admin.from("profiles").select("tenant_id").eq("id", data.user.id).maybeSingle();
  if (!(prof as any)?.tenant_id) return null;
  return { id: data.user.id, tenant: (prof as any).tenant_id };
}

/* ---------- tokens of a connected account ---------- */
type Acc = { id: string; provider: string; user_id: string; tenant_id: string; email: string; display_name: string | null; services: string[] };
const TOKEN_URL: Record<string, string> = {
  google: "https://oauth2.googleapis.com/token",
  microsoft: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
};
const creds = (p: string) => p === "google"
  ? { id: Deno.env.get("GOOGLE_CLIENT_ID") ?? "", secret: Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "" }
  : { id: Deno.env.get("MS_CLIENT_ID") ?? "", secret: Deno.env.get("MS_CLIENT_SECRET") ?? "" };
const mark = (id: string, status: "active" | "error", last_error: string | null) =>
  admin.from("connected_accounts").update({ status, last_error, updated_at: new Date().toISOString() }).eq("id", id);

async function accountAndToken(accountId: string): Promise<{ acc: Acc; token: string }> {
  const { data: acc } = await admin.from("connected_accounts").select("id, provider, user_id, tenant_id, email, display_name, services").eq("id", accountId).maybeSingle();
  if (!acc) throw new Error("That account isn't connected any more (Settings › Integrations).");
  const { data: t } = await admin.from("connected_account_tokens").select("*").eq("account_id", accountId).maybeSingle();
  if (!t) throw new Error("No sign-in stored for that account — connect it again in Settings › Integrations.");
  const a = acc as Acc, tk = t as any;
  const exp = tk.expires_at ? new Date(tk.expires_at).getTime() : 0;
  if (tk.access_token && exp - Date.now() > 120_000) return { acc: a, token: tk.access_token };
  if (a.provider === "linkedin" || a.provider === "meta") {
    if (!tk.refresh_token) { await mark(a.id, "error", `Access expired — sign in to ${a.provider === "linkedin" ? "LinkedIn" : "Meta"} again.`); throw new Error(`Access to ${a.email} expired — connect it again in Settings › Integrations.`); }
  }
  if (!TOKEN_URL[a.provider]) throw new Error("This account can't renew its access here.");
  const c = creds(a.provider);
  const res = await fetch(TOKEN_URL[a.provider], {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, grant_type: "refresh_token", refresh_token: tk.refresh_token ?? "" }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    const m = j.error_description || j.error || `Token error ${res.status}`;
    await mark(a.id, "error", m);
    throw new Error(`Couldn't renew access to ${a.email}: ${m} — connect it again in Settings › Integrations.`);
  }
  await admin.from("connected_account_tokens").update({
    access_token: j.access_token, refresh_token: j.refresh_token ?? tk.refresh_token,
    expires_at: new Date(Date.now() + (j.expires_in ?? 3600) * 1000).toISOString(), updated_at: new Date().toISOString(),
  }).eq("account_id", a.id);
  await mark(a.id, "active", null);
  return { acc: a, token: j.access_token };
}

/* ---------- mail ---------- */
const b64 = (s: string) => { const b = new TextEncoder().encode(s); let x = ""; for (let i = 0; i < b.length; i += 0x8000) x += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(x); };
const b64url = (s: string) => b64(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const encWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const cleanAddr = (s: unknown) => String(s ?? "").trim().replace(/[\r\n<>"]/g, "");
const okAddr = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

async function sendGmail(token: string, m: { to: string[]; subject: string; html: string; from: string; replyTo?: string | null }) {
  const lines = [
    `From: ${m.from}`, `To: ${m.to.join(", ")}`, `Subject: ${encWord(m.subject)}`,
    ...(m.replyTo ? [`Reply-To: ${m.replyTo}`] : []),
    "MIME-Version: 1.0", "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "",
    (b64(m.html).match(/.{1,76}/g) ?? []).join("\r\n"),
  ];
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ raw: b64url(lines.join("\r\n")) }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (r.status === 429) return { ok: false, error: "throttled", retryAfter: Number(r.headers.get("retry-after")) || 60 };
  if (!r.ok) {
    const msg = j?.error?.message || `Gmail error ${r.status}`;
    if (/insufficient|scope/i.test(msg)) return { ok: false, error: "This Gmail account can't send yet: connect it again in Settings › Integrations (allow sending)." };
    return { ok: false, error: msg };
  }
  return { ok: true, messageId: j.id ?? null };
}
async function sendGraph(token: string, m: { to: string[]; subject: string; html: string; from: string | null; replyTo?: string | null }) {
  const msg: any = { subject: m.subject, body: { contentType: "HTML", content: m.html }, toRecipients: m.to.map((a) => ({ emailAddress: { address: a } })) };
  if (m.from) msg.from = { emailAddress: { address: m.from } };
  if (m.replyTo) msg.replyTo = [{ emailAddress: { address: m.replyTo } }];
  const r = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ message: msg, saveToSentItems: true }),
  });
  if (r.status === 429) return { ok: false, error: "throttled", retryAfter: Number(r.headers.get("retry-after")) || 30 };
  if (!r.ok) {
    const j: any = await r.json().catch(() => ({}));
    const code = j?.error?.code ?? "", msg2 = j?.error?.message || `Microsoft error ${r.status}`;
    if (/ErrorSendAsDenied|SendAs/i.test(code + msg2)) return { ok: false, error: `This mailbox may not send as ${m.from}: in Microsoft 365, give your user “Send as” on it.` };
    if (/Authorization_RequestDenied|AccessDenied|scope/i.test(code + msg2)) return { ok: false, error: "This Outlook account can't send yet: connect it again in Settings › Integrations." };
    if (/UnknownError|ServiceUnavailable|InternalServer|ServerBusy/i.test(code) || r.status >= 500) return { ok: false, error: "Microsoft server error — press Retry", retryAfter: 20 };
    return { ok: false, error: msg2 };
  }
  return { ok: true, messageId: null };
}

/* ---------- SMTP (IONOS Mail and the like): a small client over TLS ---------- */
const IONOS_HOSTS = ["smtp.ionos.es", "smtp.ionos.com", "smtp.ionos.de", "smtp.ionos.co.uk", "smtp.ionos.fr", "smtp.ionos.it", "smtp.ionos.mx"];
class SmtpError extends Error { constructor(public code: number, msg: string) { super(msg); } }
type SmtpCfg = { host: string; port: number; user: string; pass: string };
async function smtpSession(cfg: SmtpCfg, job?: { from: string; to: string[]; data: string }): Promise<string> {
  const enc = new TextEncoder(), dec = new TextDecoder();
  let conn: any = cfg.port === 465 ? await Deno.connectTls({ hostname: cfg.host, port: cfg.port }) : await Deno.connect({ hostname: cfg.host, port: cfg.port });
  let buf = "";
  const readLine = async (): Promise<string> => {
    while (!buf.includes("\r\n")) {
      const chunk = new Uint8Array(8192);
      const n = await conn.read(chunk);
      if (n === null) throw new SmtpError(0, "The mail server closed the connection.");
      buf += dec.decode(chunk.subarray(0, n));
    }
    const i = buf.indexOf("\r\n"); const line = buf.slice(0, i); buf = buf.slice(i + 2); return line;
  };
  const read = async () => { let text = ""; for (;;) { const l = await readLine(); text += l.slice(4) + " "; if (l[3] !== "-") return { code: Number(l.slice(0, 3)), text: text.trim() }; } };
  const write = async (str: string) => { const b = enc.encode(str); let o = 0; while (o < b.length) o += await conn.write(b.subarray(o)); };
  const cmd = async (line: string, ok: number[]) => { await write(line + "\r\n"); const r = await read(); if (!ok.includes(r.code)) throw new SmtpError(r.code, r.text); return r; };
  const run = async () => {
    const hi = await read(); if (hi.code !== 220) throw new SmtpError(hi.code, hi.text);
    let ehlo = await cmd("EHLO next-crm", [250]);
    if (cfg.port !== 465) {
      if (!/STARTTLS/i.test(ehlo.text)) throw new SmtpError(0, "This server doesn't offer an encrypted connection on that port.");
      await cmd("STARTTLS", [220]);
      conn = await Deno.startTls(conn, { hostname: cfg.host });
      ehlo = await cmd("EHLO next-crm", [250]);
    }
    if (!job && !cfg.user) { await write("QUIT\r\n"); return hi.text; }
    await cmd(`AUTH PLAIN ${b64(`\u0000${cfg.user}\u0000${cfg.pass}`)}`, [235]);
    if (job) {
      await cmd(`MAIL FROM:<${job.from}>`, [250]);
      for (const r of job.to) await cmd(`RCPT TO:<${r}>`, [250, 251]);
      await cmd("DATA", [354]);
      const r = await cmd(job.data.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..") + "\r\n.", [250]);
      await write("QUIT\r\n").catch(() => {});
      return r.text;
    }
    await write("QUIT\r\n").catch(() => {});
    return "ok";
  };
  try {
    return await Promise.race([run(), new Promise<string>((_, rej) => setTimeout(() => rej(new SmtpError(0, "The mail server didn't answer in time.")), 25_000))]);
  } finally { try { conn.close(); } catch { /* closed */ } }
}
const smtpFriendly = (e: unknown, host: string) => {
  const err = e as SmtpError, code = err?.code ?? 0, m = String(err?.message ?? e);
  if (code === 535 || code === 534 || /auth/i.test(m) && code >= 500) return "The address or the password wasn't accepted.";
  if (code === 550 || code === 553 || code === 554) return `${host} refused it: ${m}`;
  if (code === 421 || code === 450 || code === 451 || code === 452) return `throttled:${m}`;
  if (/connection refused|timed out|didn't answer|dns|resolve|os error/i.test(m)) return `Couldn't reach ${host}: ${m}`;
  return m;
};
function mimeMail(m: { from: string; fromName?: string | null; to: string[]; subject: string; html: string; replyTo?: string | null; domain: string }) {
  const id = `<${crypto.randomUUID()}@${m.domain}>`;
  return [
    `From: ${m.fromName ? `${encWord(m.fromName)} <${m.from}>` : m.from}`, `To: ${m.to.join(", ")}`, `Subject: ${encWord(m.subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`, `Message-ID: ${id}`,
    ...(m.replyTo ? [`Reply-To: ${m.replyTo}`] : []),
    "MIME-Version: 1.0", "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "",
    (b64(m.html).match(/.{1,76}/g) ?? []).join("\r\n"),
  ].join("\r\n");
}

/* ---------- links: the page's own preview (Open Graph) ---------- */
type LinkMeta = { url: string; title: string | null; description: string | null; image: string | null; site: string | null };
const decodeEnt = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const attrOf = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"));
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
};
/** fetch, and once more over HTTP/1.1 when a server trips over HTTP/2 */
let h1Client: any = undefined;
async function grab(url: string, init: RequestInit = {}): Promise<Response> {
  try { return await fetch(url, init); }
  catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    if (h1Client === undefined) { try { h1Client = (Deno as any).createHttpClient?.({ http2: false }) ?? null; } catch { h1Client = null; } }
    if (!h1Client) throw e;
    return await fetch(url, { ...init, client: h1Client } as any);
  }
}
const privateHost = (h: string) => /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|\[f[cd])/i.test(h);
/** The page's own card; when the site won't talk to this server (TLS quirks, bot walls), a preview service reads it. */
async function linkMeta(raw: string): Promise<LinkMeta> {
  try {
    const m = await linkMetaDirect(raw);
    if (m.title || m.image) return m;
    return (await linkMetaService(m.url).catch(() => null)) ?? m;
  } catch (e) {
    const viaService = await linkMetaService(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`).catch(() => null);
    if (viaService) return viaService;
    throw e;
  }
}
async function linkMetaService(url: string): Promise<LinkMeta | null> {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(url)}`, { signal: ctl.signal });
    const j: any = await r.json().catch(() => ({}));
    const d = j?.data;
    if (!r.ok || j?.status !== "success" || !d || (!d.title && !d.image?.url)) return null;
    return { url: d.url || url, title: d.title ? String(d.title).slice(0, 300) : null, description: d.description ? String(d.description).slice(0, 500) : null,
      image: d.image?.url ?? d.logo?.url ?? null, site: d.publisher || new URL(d.url || url).hostname.replace(/^www\./, "") };
  } finally { clearTimeout(tm); }
}
async function linkMetaDirect(raw: string): Promise<LinkMeta> {
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`); } catch { throw new Error("That isn't a web link."); }
  if (!/^https?:$/.test(u.protocol) || privateHost(u.hostname)) throw new Error("That isn't a public web link.");
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await grab(u.toString(), { redirect: "follow", signal: ctl.signal, headers: {
      "User-Agent": "Mozilla/5.0 (compatible; LinkedInBot/1.0; +http://www.linkedin.com) NextCRM/1.0", Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "Accept-Language": "es,en;q=0.8",
    } });
    const final = r.url || u.toString();
    const ct = r.headers.get("content-type") ?? "";
    if (ct.startsWith("image/")) { try { await r.body?.cancel(); } catch { /* */ } return { url: final, title: null, description: null, image: final, site: new URL(final).hostname.replace(/^www\./, "") }; }
    if (!r.ok) throw new Error(`The page answered ${r.status}.`);
    let html = "";
    const reader = r.body?.getReader(); const dec = new TextDecoder();
    if (reader) {
      let total = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.length; html += dec.decode(value, { stream: true }); if (total > 800_000 || /<\/head>/i.test(html)) break; }
      try { await reader.cancel(); } catch { /* */ }
    }
    const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
    const map = new Map<string, string>();
    for (const t of metas) {
      const k = (attrOf(t, "property") ?? attrOf(t, "name") ?? attrOf(t, "itemprop"))?.toLowerCase();
      const c = attrOf(t, "content");
      if (k && c && !map.has(k)) map.set(k, decodeEnt(c).trim());
    }
    const title = map.get("og:title") || map.get("twitter:title") || decodeEnt(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "").trim() || null;
    const description = map.get("og:description") || map.get("twitter:description") || map.get("description") || null;
    let image = map.get("og:image:secure_url") || map.get("og:image") || map.get("og:image:url") || map.get("twitter:image") || map.get("twitter:image:src") || map.get("image") || null;
    if (!image) { const l = html.match(/<link\b[^>]*rel=["']?(?:image_src|apple-touch-icon)["']?[^>]*>/i)?.[0]; if (l) image = attrOf(l, "href"); }
    if (image) { try { image = new URL(image, final).toString(); } catch { image = null; } }
    return { url: final, title: title ? title.slice(0, 300) : null, description: description ? description.slice(0, 500) : null, image, site: map.get("og:site_name") || new URL(final).hostname.replace(/^www\./, "") };
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw new Error("The page took too long to answer.");
    throw e;
  } finally { clearTimeout(tm); }
}

/* ---------- LinkedIn ---------- */
type Mention = { name: string; urn: string };
/** LinkedIn's "little text": reserved characters escaped, @Name → a real mention, #word → a hashtag. */
function liCommentary(text: string, mentions: Mention[]): string {
  const esc = (c: string) => (/[\\|{}@\[\]()<>#*_~]/.test(c) ? `\\${c}` : c);
  const ms = (Array.isArray(mentions) ? mentions : []).filter((m) => m?.name && /^urn:li:(person|organization):[\w-]+$/.test(String(m.urn)))
    .sort((a, b) => b.name.length - a.name.length);
  const tag = /[\p{L}\p{N}_]+/uy;
  let out = "", i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "@") {
      const m = ms.find((x) => text.startsWith(x.name, i + 1));
      if (m) { out += `@[${m.name.replace(/[\[\]]/g, "")}](${m.urn})`; i += 1 + m.name.length; continue; }
    }
    if (c === "#" && (i === 0 || /[\s(.,;:!?¡¿"'«]/.test(text[i - 1]))) {
      tag.lastIndex = i + 1; const h = tag.exec(text);
      if (h) { out += `{hashtag|\\#|${h[0]}}`; i += 1 + h[0].length; continue; }
    }
    out += esc(c); i++;
  }
  return out;
}
const liHeaders = (token: string, v: string) => ({ Authorization: `Bearer ${token}`, "LinkedIn-Version": v, "X-Restli-Protocol-Version": "2.0.0" });
/** A company page's number and name from its public page (when the API won't look it up). */
async function liOrgPage(vanity: string): Promise<{ id: string; name: string | null } | null> {
  const uas = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (compatible; LinkedInBot/1.0; +http://www.linkedin.com)",
  ];
  for (const ua of uas) {
    try {
      const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 8000);
      const r = await grab(`https://www.linkedin.com/company/${encodeURIComponent(vanity)}/`, { redirect: "follow", signal: ctl.signal, headers: { "User-Agent": ua, Accept: "text/html", "Accept-Language": "en-US,en;q=0.8" } });
      clearTimeout(tm);
      if (!r.ok) continue;
      const html = (await r.text()).slice(0, 2_000_000);
      const id = html.match(/urn:li:(?:organization|company|fsd_company):(\d{3,})/)?.[1] ?? html.match(/"(?:companyId|organizationId|objectUrn)"\s*:\s*"?(?:urn:li:company:)?(\d{3,})/)?.[1]
        ?? html.match(/currentCompany=(?:%5B%22|\[")(\d{3,})/)?.[1] ?? html.match(/[?&]f_C=(\d{3,})/)?.[1];
      const t = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)/i)?.[1] ?? html.match(/<title>([^<]+)/i)?.[1] ?? null;
      const name = t ? decodeEnt(t).replace(/\s*[|\-–]\s*LinkedIn.*$/i, "").replace(/^LinkedIn\s*[|\-–]\s*/i, "").trim() || null : null;
      if (id) return { id, name };
    } catch { /* next */ }
  }
  return null;
}
/** A LinkedIn company page (link, vanity name or number) → { name, urn }. The API first (a member's sign-in);
 *  when it won't, the public page. `checked` = the name came from LinkedIn as the page writes it. */
async function liOrg(token: string, ref: string): Promise<{ name: string | null; urn: string; vanity: string | null; checked: boolean }> {
  const m = ref.match(/linkedin\.com\/(?:company|school|showcase)\/([^/?#\s]+)/i);
  const key = decodeURIComponent(m ? m[1] : ref.replace(/^@/, "")).trim();
  if (!key) throw new Error("Paste the company's LinkedIn page link.");
  let last = "";
  for (const v of LI_VERSIONS) {
    const r = /^\d+$/.test(key)
      ? await fetch(`${LI}/rest/organizationsLookup?ids=List(${key})`, { headers: liHeaders(token, v) })
      : await fetch(`${LI}/rest/organizations?q=vanityName&vanityName=${encodeURIComponent(key)}`, { headers: liHeaders(token, v) });
    const j: any = await r.json().catch(() => ({}));
    if (r.ok) {
      const o = /^\d+$/.test(key) ? j?.results?.[key] : j?.elements?.[0];
      if (!o?.id) throw new Error("LinkedIn has no company page by that name.");
      const name = o.localizedName ?? o.name?.localized?.[Object.keys(o.name?.localized ?? {})[0]] ?? key;
      return { name: String(name), urn: `urn:li:organization:${o.id}`, vanity: o.vanityName ?? null, checked: true };
    }
    last = j?.message || `LinkedIn error ${r.status}`;
    if (!(r.status === 426 || /version/i.test(last))) break;
  }
  if (/^\d+$/.test(key)) return { name: null, urn: `urn:li:organization:${key}`, vanity: null, checked: false };
  const pg = await liOrgPage(key);
  if (pg) return { name: pg.name, urn: `urn:li:organization:${pg.id}`, vanity: key, checked: !!pg.name };
  throw new Error("LinkedIn didn't give this page's number. Open the page on LinkedIn, copy the number from a link like linkedin.com/company/1234567, and paste it.");
}
/** A member's own name + URN (their sign-in); kept in connected_accounts.settings so it's asked once. */
async function liMe(accountId: string): Promise<{ name: string; urn: string; picture: string | null } | null> {
  const { data: a } = await admin.from("connected_accounts").select("settings, display_name").eq("id", accountId).maybeSingle();
  const st = ((a as any)?.settings ?? {}) as any;
  if (st.urn && st.li_name) return { name: st.li_name, urn: st.urn, picture: st.picture ?? null };
  try {
    const { token } = await accountAndToken(accountId);
    const r = await fetch(`${LI}/v2/userinfo`, { headers: { Authorization: `Bearer ${token}` } });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j.sub) return null;
    const me = { name: String(j.name || [j.given_name, j.family_name].filter(Boolean).join(" ") || (a as any)?.display_name || ""), urn: `urn:li:person:${j.sub}`, picture: j.picture ?? null };
    await admin.from("connected_accounts").update({ settings: { ...st, urn: me.urn, li_name: me.name, picture: me.picture } }).eq("id", accountId);
    return me;
  } catch { return null; }
}
const LI = "https://api.linkedin.com";
const LI_VERSIONS = ["202610", "202607", "202604", "202601", "202510"];
async function liPerson(token: string): Promise<string> {
  const r = await fetch(`${LI}/v2/userinfo`, { headers: { Authorization: `Bearer ${token}` } });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.sub) throw new Error(j?.message || `LinkedIn error ${r.status} — connect LinkedIn again in Settings › Integrations.`);
  return `urn:li:person:${j.sub}`;
}
/** A picture for the post (LinkedIn Images API): its URN, or null when it can't be uploaded. */
async function liImage(token: string, owner: string, version: string, url: string): Promise<string | null> {
  try {
    const init = await fetch(`${LI}/rest/images?action=initializeUpload`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "LinkedIn-Version": version, "X-Restli-Protocol-Version": "2.0.0", "Content-Type": "application/json" },
      body: JSON.stringify({ initializeUploadRequest: { owner } }),
    });
    const j: any = await init.json().catch(() => ({}));
    const up = j?.value?.uploadUrl, urn = j?.value?.image;
    if (!init.ok || !up || !urn) return null;
    let img = await grab(url).catch(() => null);
    // LinkedIn takes JPG, PNG and GIF: WebP, AVIF, SVG… go through an image converter first
    if (!img?.ok || !/image\/(jpe?g|png|gif)/i.test(img.headers.get("content-type") ?? "")) {
      try { await img?.body?.cancel(); } catch { /* */ }
      img = await fetch(`https://wsrv.nl/?url=${encodeURIComponent(url)}&output=jpg&w=1200&we`).catch(() => null);
    }
    if (!img?.ok) return null;
    const put = await fetch(up, { method: "PUT", headers: { Authorization: `Bearer ${token}` }, body: new Uint8Array(await img.arrayBuffer()) });
    return put.ok ? urn : null;
  } catch { return null; }
}
async function liPost(token: string, text: string, link: string | null, imageUrl: string | null, mentions: Mention[] = [], meta: LinkMeta | null = null, org: string | null = null): Promise<{ urn: string; url: string }> {
  // a company page (urn:li:organization:…) needs w_organization_social — LinkedIn's Community Management API
  const author = org ? `urn:li:organization:${org}` : await liPerson(token);
  let last = "";
  // a link without a picture: LinkedIn shows a card only with the page's picture, title and summary sent along
  const card = !imageUrl && link ? (meta?.url === link || meta?.image ? meta : await linkMeta(link).catch(() => null)) : null;
  let thumb: string | null = null, pic: string | null = null;
  for (const v of LI_VERSIONS) {
    if (imageUrl && !pic) pic = await liImage(token, author, v, imageUrl);
    if (card?.image && !thumb) thumb = await liImage(token, author, v, card.image);
    // a picture and a link: the link goes at the end of the text (a post has one or the other)
    const words = pic && link && !text.includes(link) ? `${text}\n\n${link}` : text;
    const body: any = {
      author, commentary: liCommentary(words, mentions), visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false,
    };
    if (pic) body.content = { media: { id: pic } };
    if (!body.content && link) body.content = { article: {
      source: link, title: (card?.title || link.replace(/^https?:\/\/(www\.)?/, "")).slice(0, 200),
      ...(card?.description ? { description: card.description.slice(0, 250) } : {}), ...(thumb ? { thumbnail: thumb } : {}),
    } };
    const r = await fetch(`${LI}/rest/posts`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "LinkedIn-Version": v, "X-Restli-Protocol-Version": "2.0.0", "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (r.ok) {
      const urn = r.headers.get("x-restli-id") ?? r.headers.get("x-linkedin-id") ?? "";
      return { urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : "https://www.linkedin.com/in/me/recent-activity/all/" };
    }
    const j: any = await r.json().catch(() => ({}));
    last = j?.message || `LinkedIn error ${r.status}`;
    if (org && (r.status === 401 || r.status === 403)) throw new Error("LinkedIn doesn't let this connection post as the company page — connect the company pages again in Settings › Integrations › LinkedIn.");
    if (!(r.status === 426 || /version/i.test(last))) break;          // only an unknown API version is worth another try
  }
  // older API that every member app still has (text + link)
  const ugc: any = {
    author, lifecycleState: "PUBLISHED", visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
    specificContent: { "com.linkedin.ugc.ShareContent": { shareCommentary: { text }, shareMediaCategory: link ? "ARTICLE" : "NONE", ...(link ? { media: [{ status: "READY", originalUrl: link }] } : {}) } },
  };
  const r2 = await fetch(`${LI}/v2/ugcPosts`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Restli-Protocol-Version": "2.0.0", "Content-Type": "application/json" }, body: JSON.stringify(ugc) });
  if (!r2.ok) { const j2: any = await r2.json().catch(() => ({})); throw new Error(j2?.message || last || `LinkedIn error ${r2.status}`); }
  const urn = r2.headers.get("x-restli-id") ?? ((await r2.json().catch(() => ({}))) as any)?.id ?? "";
  return { urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : "https://www.linkedin.com/in/me/recent-activity/all/" };
}

/** Publish one post's LinkedIn part with an account; writes the outcome on the post. */
async function publishLinkedIn(post: any, accountId: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  const text = String(post.variants?.linkedin?.text ?? "").trim() || String(post.body ?? "");
  const link = post.link_url ? String(post.link_url).trim() : null;           // its card, even when the text also has it
  const img = (Array.isArray(post.media) ? post.media : []).find((m: any) => m?.kind !== "video" && m?.url)?.url ?? null;
  const results = { ...(post.results ?? {}) };
  const now = new Date().toISOString();
  try {
    if (!text.trim()) throw new Error("The post has no text.");
    let { acc, token } = await accountAndToken(accountId);
    if (acc.provider !== "linkedin") throw new Error("That account isn't a LinkedIn account.");
    // post as a company page: one this person's LinkedIn sign-in administers (connected_assets, kind linkedin_org)
    const asOrg = String(post.auto_accounts?.linkedin_as ?? "").replace(/\D/g, "") || null;
    if (asOrg) {
      const { data: pgs } = await admin.from("connected_assets").select("account_id").eq("kind", "linkedin_org").eq("external_id", asOrg).eq("user_id", acc.user_id);
      const own = ((pgs ?? []) as any[]).find((x) => x.account_id === accountId) ?? (pgs as any[] | null)?.[0];
      if (!own) throw new Error("That company page isn't connected to this LinkedIn account — connect the company pages in Settings › Integrations › LinkedIn, or post as yourself.");
      if (own.account_id !== accountId) ({ acc, token } = await accountAndToken(own.account_id));
    }
    const out = await liPost(token, text.slice(0, 3000), link, img, Array.isArray(post.mentions) ? post.mentions : [], post.link_preview ?? null, asOrg);
    results.linkedin = { ...(results.linkedin ?? {}), url: out.url, urn: out.urn, auto_at: now, auto_account: accountId, auto_error: null };
    const onlyLi = (post.networks ?? []).every((n: string) => n === "linkedin");
    await admin.from("marketing_posts").update({
      results, updated_at: now,
      ...(onlyLi ? { status: "published", published_at: now } : {}),
    }).eq("id", post.id);
    return { ok: true, url: out.url };
  } catch (e) {
    results.linkedin = { ...(results.linkedin ?? {}), auto_error: errMsg(e), auto_tried_at: now };
    const onlyLi = (post.networks ?? []).every((n: string) => n === "linkedin");
    await admin.from("marketing_posts").update({ results, updated_at: now, ...(onlyLi && post.status === "scheduled" ? { status: "failed" } : {}) }).eq("id", post.id);
    return { ok: false, error: errMsg(e) };
  }
}

/* =====================================================================
   Workflows (SQL 149): start by themselves when something happens, then run steps.
     trigger  campaign { campaign_id, event: sent | opened | clicked | replied | not_opened, days }
              post     { post_id | null (any), networks: [] | null, list_id | null }   once per post (and per person of a fixed list)
              form     { form_id | null (any) }                                         once per answer
              backfill: also what happened before the workflow was switched on
     steps    email  { template_id, wait_days }   a Marketing template, as a tracked send (marketing_sends.workflow_id)
              branch { days, paths: { replied, opened, none } }   waits for the e-mail before it
              task   { title, notes, assign: owner | creator | contact | <profile id>, due_days, wait_days }
              stop
   Runs: mk_workflow_runs (node = "2" or "2/opened/0"); log: mk_workflow_events.
   E-mails go from the workflow's connected account (Gmail / Outlook / IONOS), or its creator's own Outlook.
   ===================================================================== */
type WfNode = { id?: string; type: "email" | "branch" | "task" | "stop"; template_id?: string; wait_days?: number; days?: number;
  paths?: { replied?: WfNode[]; opened?: WfNode[]; none?: WfNode[] }; title?: string; notes?: string; assign?: string; due_days?: number };
const WF_DAY = 86400000;
const WF_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const wfLc = (s: unknown) => String(s ?? "").trim().toLowerCase();
function wfNodeAt(root: WfNode[], ptr: string | null): WfNode | null {
  if (!ptr) return null;
  const parts = ptr.split("/");
  let list: WfNode[] | undefined = root;
  let node: WfNode | null = null;
  for (let k = 0; k < parts.length; k += 2) {
    node = list?.[Number(parts[k])] ?? null;
    if (!node) return null;
    if (k + 1 < parts.length) list = node.paths?.[parts[k + 1] as "replied"] ?? [];
  }
  return node;
}
function wfNextPtr(root: WfNode[], ptr: string): string | null {
  const parts = ptr.split("/");
  const sib = [...parts.slice(0, -1), String(Number(parts[parts.length - 1]) + 1)].join("/");
  if (wfNodeAt(root, sib)) return sib;
  if (parts.length < 3) return null;
  return wfNextPtr(root, parts.slice(0, -2).join("/"));
}
function wfLanePtr(root: WfNode[], ptr: string, lane: string): string | null {
  const n = wfNodeAt(root, ptr);
  return (n?.paths?.[lane as "replied"] ?? []).length ? `${ptr}/${lane}/0` : wfNextPtr(root, ptr);
}
const wfDelay = (n: WfNode | null) => (n && (n.type === "email" || n.type === "task") ? Math.max(0, Number(n.wait_days) || 0) * WF_DAY : 0);
const wfFill = (text: string, vars: Record<string, string>, html: boolean) =>
  String(text ?? "").replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_m, k) => { const v = vars[String(k).toLowerCase()] ?? ""; return html ? v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!)) : v; });
const WF_TRACK = `${(Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "")}/functions/v1/manage-users`;
const wfTrackUrl = (kind: "o" | "c" | "u", sendId: string, u?: string) => `${WF_TRACK}?mk=${kind}&s=${sendId}${u ? `&u=${encodeURIComponent(u)}` : ""}`;
const wfAttr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The person's own Outlook (Integrations › Outlook, outlook_tokens): a fresh token. */
async function wfOutlookToken(userId: string): Promise<string | null> {
  const { data } = await admin.from("outlook_tokens").select("*").eq("user_id", userId).maybeSingle();
  if (!data) return null;
  if (Date.now() < new Date((data as any).expires_at).getTime() - 60_000) return (data as any).access_token;
  const sc = String((data as any).scopes ?? "").split(/\s+/).filter(Boolean).map((x) => x.replace(/^https:\/\/graph\.microsoft\.com\//i, "")).filter((x) => !/^(openid|profile|email)$/i.test(x));
  const scope = [...new Set([...(sc.length ? sc : ["Calendars.ReadWrite", "User.Read"]), "offline_access"])].join(" ");
  const c = creds("microsoft");
  const r = await fetch(TOKEN_URL.microsoft, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, grant_type: "refresh_token", refresh_token: (data as any).refresh_token ?? "", scope }) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) return null;
  await admin.from("outlook_tokens").update({ access_token: j.access_token, refresh_token: j.refresh_token ?? (data as any).refresh_token, expires_at: new Date(Date.now() + (j.expires_in ?? 3600) * 1000).toISOString() }).eq("user_id", userId);
  return j.access_token;
}
/** One e-mail from the workflow's sender. */
async function wfSend(wf: any, to: string, subject: string, html: string): Promise<{ ok: boolean; error?: string; retry?: boolean; messageId?: string | null }> {
  const replyTo = null;
  if (wf.sender_account) {
    const { data: acc } = await admin.from("connected_accounts").select("id, tenant_id, provider, email, display_name, settings").eq("id", wf.sender_account).maybeSingle();
    if (!acc || (acc as any).tenant_id !== wf.tenant_id) return { ok: false, error: "The sender account isn't connected any more (Settings › Integrations)." };
    const alias = cleanAddr(wf.from_address);
    if ((acc as any).provider === "smtp") {
      const { data: t } = await admin.from("connected_account_tokens").select("access_token").eq("account_id", (acc as any).id).maybeSingle();
      const st = (acc as any).settings ?? {}, box = String((acc as any).email);
      try {
        const data = mimeMail({ from: alias && okAddr(alias) ? alias : box, fromName: (acc as any).display_name ?? null, to: [to], subject, html, replyTo, domain: box.split("@")[1] || "mail" });
        const answer = await smtpSession({ host: st.host, port: st.port ?? 465, user: box, pass: (t as any)?.access_token ?? "" }, { from: box, to: [to], data });
        return { ok: true, messageId: answer.match(/[\w.-]{8,}/)?.[0] ?? null };
      } catch (e) { const m = smtpFriendly(e, st.host); return m.startsWith("throttled:") ? { ok: false, error: "throttled", retry: true } : { ok: false, error: m }; }
    }
    try {
      const { token } = await accountAndToken((acc as any).id);
      const r = (acc as any).provider === "google"
        ? await sendGmail(token, { to: [to], subject, html, from: alias && okAddr(alias) ? alias : (acc as any).email, replyTo })
        : await sendGraph(token, { to: [to], subject, html, from: alias && okAddr(alias) && alias.toLowerCase() !== wfLc((acc as any).email) ? alias : null, replyTo });
      return r.ok ? { ok: true, messageId: (r as any).messageId ?? null } : { ok: false, error: r.error, retry: r.error === "throttled" || !!(r as any).retryAfter };
    } catch (e) { return { ok: false, error: errMsg(e) }; }
  }
  const owner = wf.created_by;
  const token = owner ? await wfOutlookToken(owner).catch(() => null) : null;
  if (!token) return { ok: false, error: "No sender: pick an account to send from (Gmail, Outlook or IONOS), or connect your Outlook." };
  const r = await sendGraph(token, { to: [to], subject, html, from: null, replyTo });
  return r.ok ? { ok: true } : { ok: false, error: r.error, retry: r.error === "throttled" || !!(r as any).retryAfter };
}

/** Replies to marketing e-mails (workflow ones and the campaigns workflows listen to), from the synced mailboxes. */
async function wfScanReplies(tenant: string, campaignIds: string[]) {
  const since = new Date(Date.now() - 30 * WF_DAY).toISOString();
  const or = [`workflow_id.not.is.null`, ...(campaignIds.length ? [`campaign_id.in.(${campaignIds.join(",")})`] : [])].join(",");
  const { data: sends } = await admin.from("marketing_sends").select("id, email, sent_at, campaign_id").eq("tenant_id", tenant).eq("status", "sent").is("replied_at", null).gte("sent_at", since).or(or).limit(5000);
  const list = (sends ?? []) as any[];
  if (!list.length) return 0;
  const by = new Map<string, any[]>();
  list.forEach((s) => { const k = wfLc(s.email); if (k) by.set(k, [...(by.get(k) ?? []), s]); });
  const { data: msgs } = await admin.from("ticket_mail_messages").select("from_email, received_at").eq("tenant_id", tenant).eq("direction", "in").gte("received_at", since).limit(20000);
  let n = 0;
  for (const m of (msgs ?? []) as any[]) {
    const ss = by.get(wfLc(m.from_email)); if (!ss) continue;
    for (const s of ss) {
      if (s._done || !s.sent_at || m.received_at < s.sent_at) continue;
      s._done = true; n++;
      await admin.from("marketing_sends").update({ replied_at: m.received_at }).eq("id", s.id).is("replied_at", null);
      await admin.from("marketing_events").insert({ tenant_id: tenant, campaign_id: s.campaign_id, send_id: s.id, kind: "reply" });
    }
  }
  return n;
}

/** People's details for e-mails and tasks (contact + its first company). */
async function wfPerson(contactId: string | null, fallback: { email?: string | null; name?: string | null }) {
  let c: any = null, co: any = null;
  if (contactId) {
    c = (await admin.from("contacts").select("id, first_name, last_name, email, position, city, marketing_opt_out").eq("id", contactId).maybeSingle()).data;
    const link = (await admin.from("company_contacts").select("company_id").eq("contact_id", contactId).limit(1)).data?.[0];
    if (link) co = (await admin.from("companies").select("id, name, city").eq("id", (link as any).company_id).maybeSingle()).data;
  }
  const first = c?.first_name ?? String(fallback.name ?? "").split(" ")[0] ?? "";
  const full = [c?.first_name, c?.last_name].filter(Boolean).join(" ") || String(fallback.name ?? "");
  return {
    contact: c, company: co,
    email: String(c?.email || fallback.email || "").trim(),
    vars: { first_name: first, last_name: c?.last_name ?? "", full_name: full, email: String(c?.email || fallback.email || ""), company: co?.name ?? "", position: c?.position ?? "", city: c?.city ?? co?.city ?? "" } as Record<string, string>,
  };
}

/** New runs for what happened since the last look (or since it was switched on). */
async function wfEnrol(wf: any): Promise<number> {
  const tr = wf.trigger ?? {};
  const after = tr.backfill ? "1970-01-01T00:00:00Z" : (wf.activated_at ?? wf.created_at);
  const rows: any[] = [];
  const add = (source: string, x: Record<string, unknown>) => rows.push({ tenant_id: wf.tenant_id, workflow_id: wf.id, source, status: "active", node: "0", next_at: new Date().toISOString(), ...x });
  if (tr.kind === "campaign" && tr.campaign_id) {
    const ev = String(tr.event ?? "opened");
    let q = admin.from("marketing_sends").select("id, contact_id, email, name, merge, sent_at, opened_at, clicked_at, replied_at, bounced_at, unsubscribed_at")
      .eq("campaign_id", tr.campaign_id).eq("status", "sent").limit(5000);
    if (ev === "opened") q = q.not("opened_at", "is", null).gte("opened_at", after);
    else if (ev === "clicked") q = q.not("clicked_at", "is", null).gte("clicked_at", after);
    else if (ev === "replied") q = q.not("replied_at", "is", null).gte("replied_at", after);
    else if (ev === "not_opened") {
      const d = Math.max(0, Number(tr.days) || 3);
      q = q.is("opened_at", null).is("bounced_at", null).is("unsubscribed_at", null).lte("sent_at", new Date(Date.now() - d * WF_DAY).toISOString()).gte("sent_at", new Date(new Date(after).getTime() - d * WF_DAY).toISOString());
    } else q = q.gte("sent_at", after);
    const { data } = await q;
    ((data ?? []) as any[]).forEach((s) => add(`send:${s.id}`, { contact_id: s.contact_id, email: s.email, name: s.name, merge: { ...(s.merge ?? {}), trigger_send: s.id } }));
  } else if (tr.kind === "form") {
    let q = admin.from("mk_form_responses").select("id, form_id, contact_id, company_id, email, created_at").eq("tenant_id", wf.tenant_id).gte("created_at", after).order("created_at").limit(2000);
    if (tr.form_id) q = q.eq("form_id", tr.form_id);
    const { data } = await q;
    const forms = new Map(((await admin.from("mk_forms").select("id, name").eq("tenant_id", wf.tenant_id)).data ?? []).map((f: any) => [f.id, f.name]));
    ((data ?? []) as any[]).forEach((r) => add(`form:${r.id}`, { contact_id: r.contact_id, company_id: r.company_id, email: r.email, merge: { form_name: forms.get(r.form_id) ?? "" } }));
  } else if (tr.kind === "post") {
    let q = admin.from("marketing_posts").select("id, title, body, networks, published_at, results, status").eq("tenant_id", wf.tenant_id).eq("status", "published").gte("published_at", after).limit(200);
    if (tr.post_id) q = q.eq("id", tr.post_id);
    const { data } = await q;
    const nets: string[] = Array.isArray(tr.networks) ? tr.networks : [];
    const posts = ((data ?? []) as any[]).filter((p) => !nets.length || (p.networks ?? []).some((n: string) => nets.includes(n)));
    let people: { contact_id: string; email: string | null; name: string | null }[] = [];
    if (posts.length && tr.list_id) {
      const { data: mem } = await admin.from("marketing_list_members").select("contact_id, company_id").eq("list_id", tr.list_id).limit(20000);
      const cts = new Set<string>(), cos = new Set<string>();
      ((mem ?? []) as any[]).forEach((m) => { if (m.contact_id) cts.add(m.contact_id); else if (m.company_id) cos.add(m.company_id); });
      if (cos.size) ((await admin.from("company_contacts").select("contact_id").in("company_id", [...cos].slice(0, 2000))).data ?? []).forEach((x: any) => cts.add(x.contact_id));
      for (let i = 0; i < [...cts].length; i += 500) {
        const { data: cs } = await admin.from("contacts").select("id, email, first_name, last_name").in("id", [...cts].slice(i, i + 500));
        ((cs ?? []) as any[]).forEach((c) => people.push({ contact_id: c.id, email: c.email, name: [c.first_name, c.last_name].filter(Boolean).join(" ") }));
      }
    }
    for (const p of posts) {
      const merge = { post_title: p.title || String(p.body ?? "").slice(0, 80), post_url: p.results?.linkedin?.url ?? "" };
      if (tr.list_id) people.forEach((x) => add(`post:${p.id}:${x.contact_id}`, { contact_id: x.contact_id, email: x.email, name: x.name, merge }));
      else add(`post:${p.id}`, { merge });
    }
  }
  if (!rows.length) return 0;
  let made = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const { data, error } = await admin.from("mk_workflow_runs").upsert(rows.slice(i, i + 500), { onConflict: "workflow_id,source", ignoreDuplicates: true }).select("id");
    if (!error) made += (data ?? []).length;
  }
  if (made) await admin.from("mk_workflow_events").insert({ tenant_id: wf.tenant_id, workflow_id: wf.id, kind: "enrol", detail: { made } });
  return made;
}

/** Moves one run along: the step it's on, then the next ones that are due now; stops at a wait. */
async function wfAdvance(wf: any, flow: WfNode[], r: any, tpls: Map<string, any>, lim: { budget: number; deadline: number }, stats: any) {
  let ptr: string | null = r.node ?? "0";
  let waitUntil: string | null = r.wait_until ?? null;
  let lastSend: string | null = r.last_send_id ?? null;
  const ev = (node: string | null, kind: string, detail: Record<string, unknown> = {}) =>
    admin.from("mk_workflow_events").insert({ tenant_id: wf.tenant_id, workflow_id: wf.id, run_id: r.id, node, kind, detail }).then(() => {}, () => {});
  const save = (patch: Record<string, unknown>) => admin.from("mk_workflow_runs").update({ ...patch, last_send_id: lastSend, updated_at: new Date().toISOString() }).eq("id", r.id);
  const finish = async (status = "done", error: string | null = null) => { await ev(ptr, status === "done" ? "end" : status, error ? { error } : {}); await save({ status, next_at: null, wait_until: null, node: ptr ?? r.node, error }); stats.finished++; };
  const go = async (next: string | null, minGap = 0): Promise<boolean> => {
    if (!next) { await finish(); return false; }
    const wait = Math.max(wfDelay(wfNodeAt(flow, next)), minGap);
    ptr = next; waitUntil = null;
    if (wait > 0) { await save({ node: next, wait_until: null, next_at: new Date(Date.now() + wait).toISOString() }); return false; }
    return true;
  };
  const who = await wfPerson(r.contact_id ?? null, { email: r.email, name: r.name });
  const vars = { ...who.vars, ...(r.merge ?? {}), workflow: wf.name ?? "" } as Record<string, string>;
  for (let guard = 0; guard < 16; guard++) {
    const n = wfNodeAt(flow, ptr);
    if (!n || n.type === "stop") { await finish(); return; }

    if (n.type === "email") {
      const t = n.template_id ? tpls.get(n.template_id) : null;
      const to = who.email;
      let skip: string | null = null;
      if (!t) skip = "The template of this step was deleted.";
      else if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) skip = "No e-mail address.";
      else if (who.contact?.marketing_opt_out) skip = "Unsubscribed.";
      else {
        const { data: un } = await admin.from("marketing_unsubscribes").select("id").eq("tenant_id", wf.tenant_id).ilike("email", to).limit(1);
        if ((un ?? []).length) skip = "Unsubscribed.";
      }
      if (!skip) {
        // an interrupted run doesn't send the same step twice
        const { data: done } = await admin.from("marketing_sends").select("id").eq("wf_run", r.id).eq("wf_node", ptr).eq("status", "sent").limit(1);
        if ((done ?? []).length) lastSend = (done as any[])[0].id;
        else {
          if (lim.budget <= 0 || Date.now() > lim.deadline) { await save({ node: ptr }); return; }
          lim.budget -= 1;
          const ins = await admin.from("marketing_sends").insert({ tenant_id: wf.tenant_id, campaign_id: null, workflow_id: wf.id, wf_run: r.id, wf_node: ptr, contact_id: r.contact_id ?? null,
            email: to, name: vars.full_name || null, merge: vars, status: "claimed", claimed_at: new Date().toISOString() }).select("id").single();
          if (ins.error) { await finish("failed", ins.error.message); return; }
          const sid = (ins.data as any).id as string;
          const vals = { ...vars, unsubscribe_url: wfTrackUrl("u", sid), unsubscribe_email: "" };
          const links: string[] = [];
          let body = String(t.body_html ?? "").replace(/(<a\b[^>]*?\bhref=")([^"]+)(")/gi, (m: string, a: string, href: string, z: string) => {
            const raw = href.replace(/&amp;/g, "&");
            if (!/^https?:\/\//i.test(raw) || raw.includes("{{") || raw.startsWith(WF_TRACK)) return m;
            links.push(raw); return a + wfAttr(wfTrackUrl("c", sid, raw)) + z;
          });
          body = wfFill(body, vals, true);
          const pre = t.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${wfAttr(wfFill(t.preheader, vals, false))}</div>` : "";
          const pixel = `<img src="${wfTrackUrl("o", sid)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">`;
          const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1b1f1b;max-width:640px">${pre}${body}${pixel}</div>`;
          const subject = wfFill(String(t.subject ?? t.name ?? ""), vals, false).replace(/\s+/g, " ").trim() || "(no subject)";
          const res = await wfSend(wf, to, subject, html);
          if (res.ok) {
            await admin.from("marketing_sends").update({ status: "sent", sent_at: new Date().toISOString(), message_id: res.messageId ?? null, links }).eq("id", sid);
            lastSend = sid; stats.sent++;
            await ev(ptr, "email", { template: t.name, to, send: sid });
          } else if (res.retry) {
            await admin.from("marketing_sends").delete().eq("id", sid);
            await save({ node: ptr, next_at: new Date(Date.now() + 15 * 60_000).toISOString() }); return;
          } else {
            await admin.from("marketing_sends").update({ status: "failed", error: String(res.error ?? "Failed").slice(0, 500), links }).eq("id", sid);
            stats.failed++;
            await ev(ptr, "error", { template: t.name, to, error: res.error });
            await admin.from("mk_workflows").update({ last_error: `${to}: ${res.error}` }).eq("id", wf.id);
            // a sender problem: try again tomorrow rather than skipping people
            await save({ node: ptr, next_at: new Date(Date.now() + WF_DAY).toISOString() }); return;
          }
        }
      } else { stats.skipped++; await ev(ptr, "skip", { template: t?.name ?? null, reason: skip }); }
      const next = wfNextPtr(flow, ptr!);
      if (!(await go(next, wfNodeAt(flow, next)?.type === "email" ? 3600_000 : 0))) return;
      continue;
    }

    if (n.type === "task") {
      const people = new Set<string>();
      const a = String(n.assign ?? "owner");
      if (a === "owner") { if (wf.owner_id) people.add(wf.owner_id); }
      else if (a === "creator") { if (wf.created_by) people.add(wf.created_by); }
      else if (a === "contact") {
        if (r.contact_id) ((await admin.from("contact_assignees").select("profile_id").eq("contact_id", r.contact_id)).data ?? []).forEach((x: any) => people.add(x.profile_id));
      } else if (WF_UUID.test(a)) people.add(a);
      if (!people.size) { const f = wf.owner_id ?? wf.created_by; if (f) people.add(f); }
      const title = wfFill(String(n.title || "Follow up with {{full_name}}"), vars, false).replace(/\s+/g, " ").trim().slice(0, 300) || "Follow up";
      let what = "";
      if (lastSend) {
        const s = (await admin.from("marketing_sends").select("opened_at, clicked_at, replied_at").eq("id", lastSend).maybeSingle()).data as any;
        if (s) what = s.replied_at ? "replied to the e-mail" : s.clicked_at ? "clicked a link in the e-mail" : s.opened_at ? "opened the e-mail" : "hasn't opened the e-mail";
      }
      const desc = [wfFill(String(n.notes ?? ""), vars, false), `From the marketing workflow "${wf.name}"${vars.full_name || r.email ? ` — ${vars.full_name || r.email}${vars.company ? ` (${vars.company})` : ""}${what ? ` ${what}` : ""}` : ""}.`].filter(Boolean).join("\n\n");
      const due = new Date(Date.now() + Math.max(0, Number(n.due_days) || 0) * WF_DAY).toISOString();
      let made = 0;
      for (const p of people) {
        const { error } = await admin.from("tracking_tasks").insert({ tenant_id: wf.tenant_id, tracking_id: null, title, description: desc, kind: "quick", priority: "normal", status: "todo", progress: 0,
          due_at: due, assignee_id: p, company_id: r.company_id ?? who.company?.id ?? null, requester_contact_id: r.contact_id ?? null, source: "manual", external_ref: `mk-wf:${wf.id}:${r.id}:${ptr}`, created_by: wf.created_by ?? p });
        if (!error) made++;
      }
      stats.tasks += made;
      await ev(ptr, "task", { title, people: [...people], made });
      if (!(await go(wfNextPtr(flow, ptr!)))) return;
      continue;
    }

    if (n.type === "branch") {
      const days = Math.max(0, Number(n.days) || 0);
      if (!waitUntil || r.node !== ptr) { waitUntil = new Date(Date.now() + days * WF_DAY).toISOString(); r.node = ptr; }
      const s = lastSend ? (await admin.from("marketing_sends").select("opened_at, clicked_at, replied_at").eq("id", lastSend).maybeSingle()).data as any : null;
      let lane: string | null = null;
      if (s?.replied_at) lane = "replied";
      else if (Date.now() >= new Date(waitUntil).getTime()) lane = s?.opened_at || s?.clicked_at ? "opened" : "none";
      if (!lane) {
        const nextCheck = Math.min(new Date(waitUntil).getTime(), Date.now() + 3600_000);
        await save({ node: ptr, wait_until: waitUntil, next_at: new Date(Math.max(nextCheck, Date.now() + 5 * 60_000)).toISOString() });
        return;
      }
      stats.branched++;
      await ev(ptr, "branch", { lane });
      if (!(await go(wfLanePtr(flow, ptr!, lane)))) return;
      continue;
    }
    await finish(); return;
  }
  await save({ node: ptr, wait_until: waitUntil });
}

/** Every active workflow (of one company, or of all): new runs, then each due run a step further. */
async function wfDue(only?: { tenant?: string; id?: string }) {
  const deadline = Date.now() + 110_000;
  let q = admin.from("mk_workflows").select("*").eq("status", "active");
  if (only?.tenant) q = q.eq("tenant_id", only.tenant);
  if (only?.id) q = q.eq("id", only.id);
  const { data: wfs } = await q;
  const stats = { enrolled: 0, sent: 0, failed: 0, skipped: 0, tasks: 0, branched: 0, finished: 0, replies: 0 };
  const lim = { budget: 80, deadline };
  const tenants = new Set(((wfs ?? []) as any[]).map((w) => w.tenant_id));
  for (const t of tenants) {
    const cids = ((wfs ?? []) as any[]).filter((w) => w.tenant_id === t && w.trigger?.kind === "campaign" && w.trigger?.campaign_id).map((w) => w.trigger.campaign_id);
    stats.replies += await wfScanReplies(t, cids).catch(() => 0);
  }
  for (const wf of (wfs ?? []) as any[]) {
    if (Date.now() > deadline) break;
    try {
      stats.enrolled += await wfEnrol(wf);
      const flow = (Array.isArray(wf.flow) ? wf.flow : wf.flow?.nodes ?? []) as WfNode[];
      const { data: tp } = await admin.from("mk_templates").select("id, name, subject, preheader, body_html").eq("tenant_id", wf.tenant_id);
      const tpls = new Map(((tp ?? []) as any[]).map((x) => [x.id, x]));
      const { data: runs } = await admin.from("mk_workflow_runs").select("*").eq("workflow_id", wf.id).eq("status", "active").lte("next_at", new Date().toISOString()).order("next_at").limit(200);
      for (const r of (runs ?? []) as any[]) {
        if (Date.now() > deadline || lim.budget <= 0) break;
        await wfAdvance(wf, flow, r, tpls, lim, stats);
      }
      await admin.from("mk_workflows").update({ last_run_at: new Date().toISOString() }).eq("id", wf.id);
    } catch (e) {
      await admin.from("mk_workflows").update({ last_error: errMsg(e), last_run_at: new Date().toISOString() }).eq("id", wf.id);
    }
  }
  return stats;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const { action, ...p } = body ?? {};

    if (action === "social_due") {
      const key = req.headers.get("x-cs-cron") ?? "";
      const { data: k } = await admin.from("cs_cron_key").select("key").eq("id", 1).maybeSingle();
      if (!key || !(k as any)?.key || key !== (k as any).key) return json({ error: "Not allowed" }, 401);
      const { data: due } = await admin.from("marketing_posts").select("*")
        .eq("status", "scheduled").lte("scheduled_at", new Date().toISOString()).not("auto_accounts->linkedin", "is", null).limit(25);
      const out: any[] = [];
      for (const post of (due ?? []) as any[]) {
        const li = post.results?.linkedin;
        if (li?.auto_at || li?.auto_error || !(post.networks ?? []).includes("linkedin")) continue;
        out.push({ id: post.id, ...(await publishLinkedIn(post, String(post.auto_accounts.linkedin))) });
      }
      return json({ done: out.length, out });
    }

    if (action === "wf_due") {
      const key = req.headers.get("x-cs-cron") ?? "";
      const { data: k } = await admin.from("cs_cron_key").select("key").eq("id", 1).maybeSingle();
      if (!key || !(k as any)?.key || key !== (k as any).key) return json({ error: "Not allowed" }, 401);
      return json(await wfDue());
    }

    // test path for the cron key: look a company page up with one account
    if (action === "li_resolve_test") {
      const key = req.headers.get("x-cs-cron") ?? "";
      const { data: k } = await admin.from("cs_cron_key").select("key").eq("id", 1).maybeSingle();
      if (!key || key !== (k as any)?.key) return json({ error: "Not allowed" }, 401);
      try {
        const { token } = await accountAndToken(String(p.accountId));
        const out: any = { org: null, me: await liMe(String(p.accountId)), meta: p.url ? await linkMeta(String(p.url)).catch((e) => ({ error: errMsg(e) })) : null };
        try { out.org = await liOrg(token, String(p.ref ?? "konsolidator")); } catch (e) { out.org = { error: errMsg(e) }; }
        try { out.num = await liOrg(token, "2351906"); } catch (e) { out.num = { error: errMsg(e) }; }
        if (p.img && out.me?.urn) { for (const v of LI_VERSIONS) { out.thumb = await liImage(token, out.me.urn, v, String(p.img)); if (out.thumb) break; } }
        out.commentary = liCommentary(String(p.text ?? "Hola @Konsolidator #finanzas (test) *x*"), out.org?.urn ? [{ name: "Konsolidator", urn: out.org.urn }] : []);
        return json(out);
      } catch (e) { return json({ error: errMsg(e) }); }
    }

    if (action === "smtp_probe") {
      const host = String(p.host ?? "").toLowerCase();
      if (!/^smtp\.ionos\.[a-z.]+$/.test(host)) return json({ error: "Only IONOS hosts." }, 400);
      try { return json({ ok: true, greeting: await smtpSession({ host, port: Number(p.port) || 465, user: "", pass: "" }) }); }
      catch (e) { return json({ ok: false, error: String((e as Error).message ?? e) }); }
    }

    const me = await caller(req);
    if (!me) return json({ error: "Not authenticated" }, 401);

    if (action === "link_meta") {
      try { return json({ meta: await linkMeta(String(p.url ?? "")) }); }
      catch (e) { return json({ error: errMsg(e) }); }
    }

    if (action === "li_people") {
      const { data: rows } = await admin.from("connected_accounts").select("id, user_id, status").eq("tenant_id", me.tenant).eq("provider", "linkedin");
      const seen = new Set<string>(); const people: any[] = [];
      for (const a of (rows ?? []) as any[]) {
        const m = await liMe(a.id);
        if (m && !seen.has(m.urn)) { seen.add(m.urn); people.push({ ...m, me: a.user_id === me.id }); }
      }
      return json({ people });
    }

    if (action === "li_resolve") {
      const { data: mine } = await admin.from("connected_accounts").select("id").eq("user_id", me.id).eq("provider", "linkedin").order("connected_at").limit(1);
      let accId = (mine as any)?.[0]?.id as string | undefined;
      if (!accId) {
        const { data: any1 } = await admin.from("connected_accounts").select("id").eq("tenant_id", me.tenant).eq("provider", "linkedin").eq("status", "active").limit(1);
        accId = (any1 as any)?.[0]?.id;
      }
      if (!accId) return json({ error: "Connect LinkedIn in Settings › Integrations to tag companies." });
      try { const { token } = await accountAndToken(accId); return json({ org: await liOrg(token, String(p.ref ?? "")) }); }
      catch (e) { return json({ error: errMsg(e) }); }
    }

    if (action === "smtp_connect") {
      const email = cleanAddr(p.email).toLowerCase();
      const pass = String(p.password ?? "");
      if (!okAddr(email)) return json({ error: "Write the whole e-mail address." }, 400);
      if (!pass) return json({ error: "Write the mailbox's password." }, 400);
      const port = [465, 587].includes(Number(p.port)) ? Number(p.port) : 465;
      const want = String(p.host ?? "").trim().toLowerCase();
      if (want && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(want)) return json({ error: "That server name doesn't look right." }, 400);
      const hosts = want ? [want] : IONOS_HOSTS;
      let host = "", last = "";
      for (const h of hosts) {
        try { await smtpSession({ host: h, port, user: email, pass }); host = h; break; }
        catch (e) { last = smtpFriendly(e, h); if (want) break; }
      }
      if (!host) return json({ error: want ? last : `None of IONOS' servers accepted it: ${last}` }, 400);
      const label = String(p.label ?? "").trim() || (/ionos/.test(host) ? "IONOS" : host);
      const row = {
        tenant_id: me.tenant, user_id: me.id, provider: "smtp", email, display_name: String(p.name ?? "").trim() || null, services: ["mail"],
        settings: { host, port, label }, scopes: null, status: "active", last_error: null, updated_at: new Date().toISOString(),
      };
      const up = await admin.from("connected_accounts").upsert(row, { onConflict: "user_id,provider,email" }).select("id, provider, email, display_name, services, status, last_error, connected_at, updated_at, settings").single();
      if (up.error) return json({ error: up.error.message }, 400);
      await admin.from("connected_account_tokens").upsert({
        account_id: (up.data as any).id, access_token: pass, refresh_token: null,
        expires_at: new Date(Date.now() + 10 * 365 * 86400_000).toISOString(), updated_at: new Date().toISOString(),
      });
      return json({ account: up.data });
    }

    if (action === "smtp_check") {
      const { data: acc } = await admin.from("connected_accounts").select("id, user_id, provider, email, settings").eq("id", p.id).maybeSingle();
      if (!acc || (acc as any).user_id !== me.id || (acc as any).provider !== "smtp") return json({ error: "Account not found." }, 404);
      const { data: t } = await admin.from("connected_account_tokens").select("access_token").eq("account_id", p.id).maybeSingle();
      const st = (acc as any).settings ?? {};
      try {
        await smtpSession({ host: st.host, port: st.port ?? 465, user: (acc as any).email, pass: (t as any)?.access_token ?? "" });
        await mark(p.id, "active", null);
        return json({ status: "active" });
      } catch (e) {
        const m = smtpFriendly(e, st.host);
        await mark(p.id, "error", m);
        return json({ status: "error", error: m });
      }
    }

    if (action === "mail_send") {
      const to = (Array.isArray(p.to) ? p.to : []).map(cleanAddr).filter(okAddr);
      if (!to.length) return json({ error: "No valid address to send to." }, 400);
      const { data: acc } = await admin.from("connected_accounts").select("id, user_id, provider, services, email").eq("id", p.accountId).maybeSingle();
      if (!acc || (acc as any).user_id !== me.id) return json({ error: "You can only send from your own connected accounts — the person who connected it has to send this campaign." }, 403);
      if (!["google", "microsoft", "smtp"].includes((acc as any).provider)) return json({ error: "Only Gmail, Outlook and SMTP (IONOS) accounts send e-mail." }, 400);
      const alias = cleanAddr(p.from);
      const replyTo = cleanAddr(p.replyTo) || null;
      if ((acc as any).provider === "smtp") {
        const { data: full } = await admin.from("connected_accounts").select("settings, display_name").eq("id", (acc as any).id).maybeSingle();
        const { data: t } = await admin.from("connected_account_tokens").select("access_token").eq("account_id", (acc as any).id).maybeSingle();
        const st = (full as any)?.settings ?? {};
        const box = String((acc as any).email);
        const from = alias && okAddr(alias) ? alias : box;
        try {
          const data = mimeMail({ from, fromName: (full as any)?.display_name ?? null, to, subject: String(p.subject ?? "").slice(0, 900), html: String(p.html ?? ""), replyTo: replyTo && okAddr(replyTo) ? replyTo : null, domain: box.split("@")[1] || "mail" });
          const answer = await smtpSession({ host: st.host, port: st.port ?? 465, user: box, pass: (t as any)?.access_token ?? "" }, { from: box, to, data });
          return json({ ok: true, messageId: answer.match(/[\w.-]{8,}/)?.[0] ?? null });
        } catch (e) {
          const m = smtpFriendly(e, st.host);
          if (m.startsWith("throttled:")) return json({ ok: false, error: "throttled", retryAfter: 120 });
          if (/password wasn't accepted/.test(m)) await mark((acc as any).id, "error", m);
          return json({ ok: false, error: m });
        }
      }
      const { token } = await accountAndToken((acc as any).id);
      const m = { to, subject: String(p.subject ?? "").slice(0, 900), html: String(p.html ?? ""), replyTo: replyTo && okAddr(replyTo) ? replyTo : null };
      const r = (acc as any).provider === "google"
        ? await sendGmail(token, { ...m, from: alias && okAddr(alias) ? alias : (acc as any).email })
        : await sendGraph(token, { ...m, from: alias && okAddr(alias) && alias.toLowerCase() !== String((acc as any).email).toLowerCase() ? alias : null });
      return json(r, r.ok ? 200 : 200);
    }

    // a workflow now (switched on, or "Run now"): new runs and the steps that are due
    if (action === "wf_run") {
      const { data: wf } = await admin.from("mk_workflows").select("id, tenant_id, status").eq("id", p.id).maybeSingle();
      if (!wf || (wf as any).tenant_id !== me.tenant) return json({ error: "Workflow not found." }, 404);
      if ((wf as any).status !== "active") return json({ error: "Switch the workflow on first." }, 400);
      return json(await wfDue({ id: (wf as any).id }));
    }

    if (action === "social_publish") {
      const { data: post } = await admin.from("marketing_posts").select("*").eq("id", p.postId).maybeSingle();
      if (!post || (post as any).tenant_id !== me.tenant) return json({ error: "Post not found." }, 404);
      let accId = String((post as any).auto_accounts?.linkedin ?? "");
      if (accId) {
        const { data: a } = await admin.from("connected_accounts").select("user_id").eq("id", accId).maybeSingle();
        if ((a as any)?.user_id !== me.id) accId = "";
      }
      if (!accId) {
        const { data: mine } = await admin.from("connected_accounts").select("id").eq("user_id", me.id).eq("provider", "linkedin").order("connected_at").limit(1);
        accId = (mine as any)?.[0]?.id ?? "";
      }
      if (!accId) return json({ error: "Connect your LinkedIn in Settings › Integrations first." }, 400);
      const r = await publishLinkedIn(post, accId);
      return json(r, 200);
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: errMsg(e) }, 500);
  }
});
