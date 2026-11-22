import { useEffect, useState } from "react";
import { supabase } from "../../components/api/supabase";
import { addAccount } from "../../components/api/connectedAccounts";
import "./avatars.css";

/* =====================================================================
   Profile photos (SQL 158: profiles.avatar_url, public bucket "avatars").
   One small cache for the whole app: who has a photo. Anywhere a person's
   circle is drawn, <Pic id=…> puts their photo in it (else nothing, and the
   circle keeps its initials). Settings › Your account sets / removes yours.
   ===================================================================== */
const urls = new Map<string, string>();
/** The same photos by full name and by e-mail, for the places that only know a person's name. */
const byName = new Map<string, string>();
const fold = (s: string) => (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
let loading: Promise<void> | null = null;
let loadedAt = 0;
const EVENT = "np-avatars";
const tell = () => window.dispatchEvent(new Event(EVENT));

/** Who has a photo (asked once; again after 10 minutes). */
export function loadAvatars(force = false): Promise<void> {
  if (!force && (loading || Date.now() - loadedAt < 600_000)) return loading ?? Promise.resolve();
  loading = (async () => {
    try {
      const { data, error } = await supabase.from("profiles").select("id, first_name, last_name, email, avatar_url").not("avatar_url", "is", null);
      if (!error) {
        urls.clear(); byName.clear();
        ((data ?? []) as any[]).forEach((r) => {
          if (!r?.id || !r?.avatar_url) return;
          urls.set(r.id, r.avatar_url);
          const full = fold([r.first_name, r.last_name].filter(Boolean).join(" "));
          if (full) byName.set(full, r.avatar_url);
          if (r.email) byName.set(fold(r.email), r.avatar_url);
        });
        loadedAt = Date.now();
        tell();
      }
    } catch { /* no column yet: initials stay */ }
    loading = null;
  })();
  return loading;
}
/** The photo of a person (their profile id, with or without "employee:" — or else their full name or e-mail), if they put one. */
export function avatarUrl(id: string | null | undefined, name?: string | null): string | null {
  const byId = id ? urls.get(id.replace(/^employee:/, "")) : undefined;
  if (byId) return byId;
  return name ? byName.get(fold(name)) ?? null : null;
}
/** After you change yours: everything that shows you updates at once. */
export function setAvatar(id: string, url: string | null) {
  const old = urls.get(id);
  if (url) urls.set(id, url); else urls.delete(id);
  if (old) for (const [k, v] of byName) if (v === old) { if (url) byName.set(k, url); else byName.delete(k); }
  tell();
  if (url) void loadAvatars(true);
}
/** Re-renders the component when the photos are known or one changes. */
export function useAvatars(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const on = () => setV((x) => x + 1);
    window.addEventListener(EVENT, on);
    void loadAvatars();
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return v;
}
/** The person's photo, filling the circle it sits in (nothing when they have none). */
export function Pic({ id, name, alt = "" }: { id?: string | null; name?: string | null; alt?: string }) {
  useAvatars();
  const u = avatarUrl(id, name);
  const [bad, setBad] = useState(false);
  if (!u || bad) return null;
  return <img className="np-pic" src={u} alt={alt} loading="lazy" draggable={false} onError={() => setBad(true)} />;
}
/** A circle's content: the photo if there is one, else the initials. */
export function PicOr({ id, name, children }: { id?: string | null; name?: string | null; children: React.ReactNode }) {
  useAvatars();
  return avatarUrl(id, name) ? <Pic id={id} name={name} /> : <>{children}</>;
}

/* ---- yours: square, small, sharp ---- */
/** Crops the picture to a centred square and makes it 400 px JPEG. */
async function squareJpeg(file: File, size = 400): Promise<Blob> {
  const src = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error("That file isn't a picture we can read.")); i.src = src; });
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    const c = document.createElement("canvas");
    c.width = size; c.height = size;
    const g = c.getContext("2d")!;
    g.imageSmoothingQuality = "high";
    g.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
    return await new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("Couldn't read the picture."))), "image/jpeg", 0.9));
  } finally { URL.revokeObjectURL(src); }
}
/** Puts a new photo for you: uploads it, keeps its link on your profile, removes the old one. */
export async function uploadMyAvatar(uid: string, file: File): Promise<{ url: string | null; error: string | null }> {
  try {
    if (!/^image\//.test(file.type)) return { url: null, error: "Pick a picture (JPG, PNG, WebP…)." };
    const blob = await squareJpeg(file);
    const path = `${uid}/${crypto.randomUUID()}.jpg`;
    const up = await supabase.storage.from("avatars").upload(path, blob, { contentType: "image/jpeg", upsert: false, cacheControl: "31536000" });
    if (up.error) return { url: null, error: /bucket|not found/i.test(up.error.message) ? "Run 158_profile_photos.sql in Supabase to add profile photos." : up.error.message };
    const url = supabase.storage.from("avatars").getPublicUrl(path).data.publicUrl;
    const { error } = await supabase.from("profiles").update({ avatar_url: url }).eq("id", uid);
    if (error) { await supabase.storage.from("avatars").remove([path]); return { url: null, error: error.message }; }
    void cleanOld(uid, path);
    setAvatar(uid, url);
    return { url, error: null };
  } catch (e: any) {
    return { url: null, error: e?.message ?? "Couldn't use that picture." };
  }
}
export async function removeMyAvatar(uid: string): Promise<string | null> {
  const { error } = await supabase.from("profiles").update({ avatar_url: null }).eq("id", uid);
  if (error) return error.message;
  void cleanOld(uid, null);
  setAvatar(uid, null);
  return null;
}
async function cleanOld(uid: string, keep: string | null) {
  const { data } = await supabase.storage.from("avatars").list(uid);
  const old = ((data ?? []) as any[]).map((x) => `${uid}/${x.name}`).filter((p) => p !== keep);
  if (old.length) await supabase.storage.from("avatars").remove(old);
}

/** Your LinkedIn photo as your profile photo: LinkedIn only gives it to a signed-in app (Sign In with LinkedIn),
 *  so the first time this opens LinkedIn's sign-in; then the profile-photo function copies the picture. */
export async function linkedInAvatar(uid: string): Promise<{ url: string | null; error: string | null }> {
  const ask = async () => {
    const { data, error } = await supabase.functions.invoke("profile-photo", { body: { action: "linkedin" } });
    if (error) {
      let msg = error.message;
      try { const b = await (error as any).context?.json?.(); if (b?.error) return b as { url?: string; error?: string; needConnect?: boolean }; } catch { /* plain error */ }
      return { error: msg } as { url?: string; error?: string; needConnect?: boolean };
    }
    return (data ?? {}) as { url?: string; error?: string; needConnect?: boolean };
  };
  let r = await ask();
  if (r.needConnect) {
    const c = await addAccount("linkedin", []);
    if (c.error) return { url: null, error: c.error };
    r = await ask();
  }
  if (!r.url) return { url: null, error: r.error ?? "LinkedIn didn't give a photo." };
  setAvatar(uid, r.url);
  return { url: r.url, error: null };
}
