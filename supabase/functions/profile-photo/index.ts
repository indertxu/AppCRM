// =====================================================================
// Supabase Edge Function: profile-photo (Enterprise, 2026-11-20)
// Settings › Your account › "Use my LinkedIn photo": takes the picture of the LinkedIn member you signed in
// with (Sign In with LinkedIn / OpenID: /v2/userinfo → picture — the only way LinkedIn gives it out; a
// profile's page link can't be read), stores it as your profile photo (public bucket "avatars",
// <user id>/<random>.jpg — SQL 158) and keeps its link on profiles.avatar_url. Old photos of yours go.
//
// POST { action: "linkedin" }  (the caller's Supabase JWT identifies the user)
//   → { url }  or  { needConnect: true, error }  when there's no working LinkedIn sign-in yet.
// Uses the tokens the connected-accounts function stores (connected_accounts + connected_account_tokens).
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: u, error: ue } = await admin.auth.getUser(jwt);
    if (ue || !u?.user) return json({ error: "Not authenticated" }, 401);
    const uid = u.user.id;
    const { action } = await req.json().catch(() => ({ action: null }));
    if (action !== "linkedin") return json({ error: "Unknown action" }, 400);

    const { data: accs } = await admin.from("connected_accounts").select("id, updated_at").eq("user_id", uid).eq("provider", "linkedin").order("updated_at", { ascending: false });
    if (!accs?.length) return json({ needConnect: true, error: "Sign in with LinkedIn once so Next can read your photo." });
    let picture: string | null = null;
    let sawToken = false;
    for (const a of accs as any[]) {
      const { data: t } = await admin.from("connected_account_tokens").select("access_token").eq("account_id", a.id).maybeSingle();
      const tok = (t as any)?.access_token;
      if (!tok) continue;
      sawToken = true;
      const r = await fetch("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${tok}` } });
      if (!r.ok) continue;
      const j = await r.json().catch(() => ({}));
      if (j?.picture) { picture = String(j.picture); break; }
    }
    if (!picture) {
      return sawToken
        ? json({ needConnect: true, error: "LinkedIn didn't give a photo — sign in with LinkedIn again (or check your photo is visible on LinkedIn)." })
        : json({ needConnect: true, error: "Sign in with LinkedIn once so Next can read your photo." });
    }
    const img = await fetch(picture);
    if (!img.ok) return json({ error: `LinkedIn's photo couldn't be downloaded (${img.status}).` }, 502);
    const type = img.headers.get("content-type") || "image/jpeg";
    const ext = /png/.test(type) ? "png" : /webp/.test(type) ? "webp" : "jpg";
    const bytes = new Uint8Array(await img.arrayBuffer());
    const path = `${uid}/${crypto.randomUUID()}.${ext}`;
    const up = await admin.storage.from("avatars").upload(path, bytes, { contentType: /^image\//.test(type) ? type : "image/jpeg", upsert: false, cacheControl: "31536000" });
    if (up.error) return json({ error: up.error.message }, 500);
    const url = admin.storage.from("avatars").getPublicUrl(path).data.publicUrl;
    const { error: pe } = await admin.from("profiles").update({ avatar_url: url }).eq("id", uid);
    if (pe) { await admin.storage.from("avatars").remove([path]); return json({ error: pe.message }, 500); }
    const { data: list } = await admin.storage.from("avatars").list(uid);
    const old = ((list ?? []) as any[]).map((x) => `${uid}/${x.name}`).filter((p) => p !== path);
    if (old.length) await admin.storage.from("avatars").remove(old);
    return json({ url });
  } catch (e) {
    return json({ error: (e as Error)?.message ?? "Something went wrong" }, 500);
  }
});
