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
//                 (or the account the post names in auto_accounts.linkedin, when it is the caller's).
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
async function liPost(token: string, text: string, link: string | null, imageUrl: string | null, mentions: Mention[] = [], meta: LinkMeta | null = null): Promise<{ urn: string; url: string }> {
  const author = await liPerson(token);
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
    const { acc, token } = await accountAndToken(accountId);
    if (acc.provider !== "linkedin") throw new Error("That account isn't a LinkedIn account.");
    const out = await liPost(token, text.slice(0, 3000), link, img, Array.isArray(post.mentions) ? post.mentions : [], post.link_preview ?? null);
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
