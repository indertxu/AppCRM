/* =====================================================================
   Marketing ↔ the accounts connected in Settings › Integrations
   (edge function "marketing-hub"; SQL 144).
     sendFromAccount   one e-mail from your Gmail / extra Outlook account
     publishPostNow    a post's LinkedIn text, on your LinkedIn, now
     myConnections     your mail accounts (Gmail, Outlook, IONOS) + LinkedIn, for the pickers
   ===================================================================== */
import { supabase } from "./supabase";
import { listAccounts, type ConnectedAccount } from "./connectedAccounts";
import type { OutlookMail, OutlookMailResult } from "./outlookSync";

async function hub(action: string, payload: object): Promise<any> {
  const { data, error } = await supabase.functions.invoke("marketing-hub", { body: { action, ...payload } });
  if (!error) return data ?? {};
  // a 4xx carries our own message in the body
  try { const b = await (error as any).context?.json?.(); if (b?.error) return b; } catch { /* not JSON */ }
  const m = String((error as any)?.message ?? error);
  return { error: /Failed to send|fetch|404/i.test(m) ? "The marketing service isn't reachable — try again in a moment." : m };
}

/** Seconds to wait between e-mails of an SMTP mailbox: IONOS Mail allows 500 an hour (fewer in a new contract). */
export const SMTP_PACE_S = 8;
const providerOf = new Map<string, string>();
async function kindOf(accountId: string): Promise<string> {
  if (!providerOf.has(accountId)) {
    const { data } = await supabase.from("connected_accounts").select("provider").eq("id", accountId).maybeSingle();
    providerOf.set(accountId, String((data as any)?.provider ?? ""));
  }
  return providerOf.get(accountId)!;
}
/** One e-mail through a connected Gmail, Outlook or IONOS account (yours). `from` = another address of that mailbox.
 *  `pace` = seconds to wait before the next one (IONOS' hourly limit). */
export async function sendFromAccount(accountId: string, m: OutlookMail): Promise<OutlookMailResult & { pace?: number }> {
  const r = await hub("mail_send", { accountId, to: m.to, subject: m.subject, html: m.html, from: m.from ?? null, replyTo: m.replyTo ?? null, ref: m.ref ?? null });
  if (r?.ok) return { ok: true, error: null, messageId: r.messageId ?? null, pace: (await kindOf(accountId)) === "smtp" ? SMTP_PACE_S : undefined };
  if (r?.error === "throttled") return { ok: false, error: "The mailbox is limiting sends; trying again shortly.", retryAfter: Number(r.retryAfter) || 30 };
  return { ok: false, error: String(r?.error ?? "Could not send."), retryAfter: r?.retryAfter };
}

/** Publish a post's LinkedIn part now (your LinkedIn). */
export async function publishPostNow(postId: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  const r = await hub("social_publish", { postId });
  return r?.ok ? { ok: true, url: r.url } : { ok: false, error: String(r?.error ?? "Couldn't publish.") };
}

export type MailAcct = ConnectedAccount & { kind: "gmail" | "outlook" | "ionos" };
export interface MyConnections { mail: MailAcct[]; linkedin: ConnectedAccount[]; loaded: boolean }
export const NO_CONNECTIONS: MyConnections = { mail: [], linkedin: [], loaded: false };
/** Your connected accounts that marketing can use. */
export async function myConnections(): Promise<MyConnections> {
  const { accounts } = await listAccounts();
  return {
    mail: accounts.filter((a) => (a.provider === "google" || a.provider === "microsoft" || a.provider === "smtp") && a.services.includes("mail"))
      .map((a) => { providerOf.set(a.id, a.provider); return { ...a, kind: a.provider === "google" ? "gmail" as const : a.provider === "smtp" ? "ionos" as const : "outlook" as const }; }),
    linkedin: accounts.filter((a) => a.provider === "linkedin"),
    loaded: true,
  };
}

/* ---------- LinkedIn posts: @mentions and the link's own preview (SQL 146) ---------- */
/** A link's own preview card (Open Graph): what LinkedIn shows under the post. `src` = the link as written. */
export interface LinkPreview { src: string; url: string; title: string | null; description: string | null; image: string | null; site: string | null }
const metaCache = new Map<string, Promise<LinkPreview | { error: string }>>();
export function linkPreview(src: string): Promise<LinkPreview | { error: string }> {
  const k = src.trim();
  if (!metaCache.has(k)) {
    metaCache.set(k, hub("link_meta", { url: k }).then((r) => (r?.meta ? { ...r.meta, src: k } as LinkPreview : { error: String(r?.error ?? "No preview for that link.") })));
    void metaCache.get(k)!.then((r) => { if ("error" in r) setTimeout(() => metaCache.delete(k), 30_000); });
  }
  return metaCache.get(k)!;
}

/** Someone or a company page tagged in a post: "@name" in its text becomes a LinkedIn mention. */
export interface PostMention { name: string; urn: string; kind: "org" | "person"; ref?: string | null; picture?: string | null;
  /** the page name couldn't be read from LinkedIn: it must match the page exactly, so the person checks it */
  check?: boolean }
export interface LiPerson { name: string; urn: string; picture: string | null; me: boolean }
let peopleP: Promise<LiPerson[]> | null = null;
/** Colleagues who connected LinkedIn (Settings › Integrations): the people a post can tag. */
export function linkedinPeople(): Promise<LiPerson[]> {
  peopleP ??= hub("li_people", {}).then((r) => (Array.isArray(r?.people) ? r.people as LiPerson[] : [])).catch(() => []);
  void peopleP.then((x) => { if (!x.length) setTimeout(() => { peopleP = null; }, 20_000); });
  return peopleP;
}
/** A company's LinkedIn page (its link, vanity name or number) → the name and URN to tag it with. */
export async function linkedinPage(ref: string): Promise<{ name: string | null; urn: string; checked: boolean } | { error: string }> {
  const r = await hub("li_resolve", { ref });
  if (r?.org?.urn) return { name: r.org.name ?? null, urn: r.org.urn, checked: !!r.org.checked };
  return { error: String(r?.error ?? "LinkedIn didn't find that page.") };
}
