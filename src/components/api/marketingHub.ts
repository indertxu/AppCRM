/* =====================================================================
   Marketing ↔ the accounts connected in Settings › Integrations
   (edge function "marketing-hub"; SQL 144).
     sendFromAccount   one e-mail from your Gmail / extra Outlook account
     publishPostNow    a post's LinkedIn text, on your LinkedIn, now
     myConnections     your mail accounts + LinkedIn, for the pickers
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

/** One e-mail through a connected Gmail or Outlook account (yours). `from` = another address of that mailbox. */
export async function sendFromAccount(accountId: string, m: OutlookMail): Promise<OutlookMailResult> {
  const r = await hub("mail_send", { accountId, to: m.to, subject: m.subject, html: m.html, from: m.from ?? null, replyTo: m.replyTo ?? null, ref: m.ref ?? null });
  if (r?.ok) return { ok: true, error: null, messageId: r.messageId ?? null };
  if (r?.error === "throttled") return { ok: false, error: "The mailbox is limiting sends; trying again shortly.", retryAfter: Number(r.retryAfter) || 30 };
  return { ok: false, error: String(r?.error ?? "Could not send."), retryAfter: r?.retryAfter };
}

/** Publish a post's LinkedIn part now (your LinkedIn). */
export async function publishPostNow(postId: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  const r = await hub("social_publish", { postId });
  return r?.ok ? { ok: true, url: r.url } : { ok: false, error: String(r?.error ?? "Couldn't publish.") };
}

export type MailAcct = ConnectedAccount & { kind: "gmail" | "outlook" };
export interface MyConnections { mail: MailAcct[]; linkedin: ConnectedAccount[]; loaded: boolean }
export const NO_CONNECTIONS: MyConnections = { mail: [], linkedin: [], loaded: false };
/** Your connected accounts that marketing can use. */
export async function myConnections(): Promise<MyConnections> {
  const { accounts } = await listAccounts();
  return {
    mail: accounts.filter((a) => (a.provider === "google" || a.provider === "microsoft") && a.services.includes("mail"))
      .map((a) => ({ ...a, kind: a.provider === "google" ? "gmail" as const : "outlook" as const })),
    linkedin: accounts.filter((a) => a.provider === "linkedin"),
    loaded: true,
  };
}
