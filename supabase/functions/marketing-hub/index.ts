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
//   social_due    {}   header x-cs-cron = cs_cron_key.key (pg_cron, SQL 144, every 5 min)
//                 Publishes every scheduled post whose time has come and that names a
//                 LinkedIn account in auto_accounts.linkedin.
//
// Results go to marketing_posts.results.linkedin = { url, urn, auto_at } or { auto_error }.
// A post only for LinkedIn becomes "published"; with other networks it stays "scheduled"
// (Ready) so the rest are published by hand.
//
// Secrets (already set for connected-accounts): GOOGLE_CLIENT_ID / _SECRET, MS_CLIENT_ID / _SECRET.
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

/* ---------- LinkedIn ---------- */
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
    const img = await fetch(url);
    if (!img.ok) return null;
    const put = await fetch(up, { method: "PUT", headers: { Authorization: `Bearer ${token}` }, body: new Uint8Array(await img.arrayBuffer()) });
    return put.ok ? urn : null;
  } catch { return null; }
}
async function liPost(token: string, text: string, link: string | null, imageUrl: string | null): Promise<{ urn: string; url: string }> {
  const author = await liPerson(token);
  let last = "";
  for (const v of LI_VERSIONS) {
    const body: any = {
      author, commentary: text.replace(/([\\(){}\[\]<>@|~_*#])/g, "\\$1"), visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false,
    };
    if (imageUrl) { const urn = await liImage(token, author, v, imageUrl); if (urn) body.content = { media: { id: urn } }; }
    if (!body.content && link) body.content = { article: { source: link, title: link.replace(/^https?:\/\/(www\.)?/, "").slice(0, 200) } };
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
  const link = post.link_url && !text.includes(post.link_url) ? String(post.link_url) : null;
  const img = (Array.isArray(post.media) ? post.media : []).find((m: any) => m?.kind !== "video" && m?.url)?.url ?? null;
  const results = { ...(post.results ?? {}) };
  const now = new Date().toISOString();
  try {
    if (!text.trim()) throw new Error("The post has no text.");
    const { acc, token } = await accountAndToken(accountId);
    if (acc.provider !== "linkedin") throw new Error("That account isn't a LinkedIn account.");
    const out = await liPost(token, text.slice(0, 3000), link, img);
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

    const me = await caller(req);
    if (!me) return json({ error: "Not authenticated" }, 401);

    if (action === "mail_send") {
      const to = (Array.isArray(p.to) ? p.to : []).map(cleanAddr).filter(okAddr);
      if (!to.length) return json({ error: "No valid address to send to." }, 400);
      const { data: acc } = await admin.from("connected_accounts").select("id, user_id, provider, services, email").eq("id", p.accountId).maybeSingle();
      if (!acc || (acc as any).user_id !== me.id) return json({ error: "You can only send from your own connected accounts — the person who connected it has to send this campaign." }, 403);
      if (!["google", "microsoft"].includes((acc as any).provider)) return json({ error: "Only Gmail and Outlook accounts send e-mail." }, 400);
      const { token } = await accountAndToken((acc as any).id);
      const alias = cleanAddr(p.from);
      const replyTo = cleanAddr(p.replyTo) || null;
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
