import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../../api/supabase";
import { passwordProblem, PASSWORD_HINT } from "../../login/LoginPage";
import { levelName } from "../../framework/pageAccess";
import { loadBilling, markBillingSeen, unseenOf, watchBilling, eventText, billingAgo, type BillingEvent } from "../../api/billingApi";
import { PicOr, avatarUrl, useAvatars, uploadMyAvatar, removeMyAvatar, linkedInAvatar } from "../../framework/avatars";
import "./AccountSettings.css";

/* =====================================================================
   Settings › Your account (copied from Base — keep in step with src/base/pages/settings/AccountSettings.tsx).
   Enterprise adds: the company part is the owner's only (role boss), and the
   billing is a mirror of Next's console (SQL 138): what Next changed is shown
   as new with a note on top, both sides' changes are listed, and an open page
   follows the other side live
   Left: you — name, phone, job title, password, sign out.
   Right (the company's boss / org superadmin only): your company —
   the plan, who you're billed as (one or more legal entities / tax IDs,
   SQL 137 tenant_billing_entities) and what Next has billed you for the
   CRM (tenant_subscription_invoices: users, price per user, discount,
   VAT, who it was billed to, status). Invoices are written by Next's
   superadmins; the company only reads them.
   ===================================================================== */

interface Me { id: string; first_name: string | null; last_name: string | null; phone: string | null; job_title: string | null; linkedin_url?: string | null; email: string | null; role: string | null; security_level: string | null; is_org_superadmin: boolean | null; tenant_id: string | null }
interface Entity {
  id: string; legal_name: string; tax_id: string; email: string | null; phone: string | null; street: string | null; postal_code: string | null;
  city: string | null; province: string | null; country: string | null; iban: string | null; po_reference: string | null; is_default: boolean;
}
interface Invoice {
  id: string; entity_id: string | null; number: string; issued_on: string; period_start: string | null; period_end: string | null; due_on: string | null;
  plan: string | null; users: number; price_per_user: number; discount_pct: number; net: number; vat_pct: number; vat: number; total: number; currency: string;
  status: "pending" | "paid" | "overdue" | "void" | "refunded"; paid_on: string | null; bill_to_name: string | null; bill_to_tax_id: string | null;
  bill_to_address: string | null; lines: { label: string; qty?: number; unit?: number; amount: number }[] | null; pdf_url: string | null; notes: string | null;
}
const EMPTY_ENTITY: Omit<Entity, "id"> = { legal_name: "", tax_id: "", email: "", phone: "", street: "", postal_code: "", city: "", province: "", country: "Spain", iban: "", po_reference: "", is_default: false };

const svg = (...d: string[]) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{d.map((x) => <path key={x} d={x} />)}</svg>;
const I = {
  bell: svg("M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9", "M10.3 21a1.94 1.94 0 0 0 3.4 0"),
  history: svg("M3 12a9 9 0 1 0 3-6.7L3 8", "M3 3v5h5", "M12 7v5l3 2"),
  back: svg("M15 18l-6-6 6-6"),
  user: svg("M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", "M4 21a8 8 0 0 1 16 0"),
  lock: svg("M6 11h12v10H6z", "M8 11V7a4 4 0 0 1 8 0v4"),
  out: svg("M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "M16 17l5-5-5-5", "M21 12H9"),
  building: svg("M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16", "M16 9h3a1 1 0 0 1 1 1v11", "M8 7h4M8 11h4M8 15h4", "M2 21h20"),
  doc: svg("M7 3h7l5 5v13H7z", "M14 3v5h5", "M10 13h6M10 17h6"),
  star: svg("M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.8 6.8 19.6l1-5.8-4.3-4.1 5.9-.9z"),
  plus: svg("M12 5v14M5 12h14"),
  edit: svg("M4 20h4L19 9l-4-4L4 16z"),
  trash: svg("M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13"),
  chev: svg("M9 6l6 6-6 6"),
  down: svg("M12 4v11", "M7 10l5 5 5-5", "M5 20h14"),
  camera: svg("M4 8h3l2-3h6l2 3h3v11H4z", "M12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"),
  spark: svg("M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"),
};

const money = (v: number | null | undefined, cur = "EUR") =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: cur || "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v ?? 0));
const day = (d: string | null | undefined) => (d ? new Date(d + (d.length === 10 ? "T12:00:00" : "")).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }) : "—");
const initials = (a: string, b: string, email: string) => ((a?.[0] ?? "") + (b?.[0] ?? "") || email?.[0] || "?").toUpperCase();
const STATUS: Record<Invoice["status"], string> = { paid: "Paid", pending: "Pending", overdue: "Overdue", void: "Void", refunded: "Refunded" };
const PLAN: Record<string, string> = { base: "Base", enterprise: "Enterprise" };

export default function AccountSettings({ onBack }: { onBack: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [form, setForm] = useState({ first_name: "", last_name: "", phone: "", job_title: "", linkedin_url: "" });
  const [saveState, setSaveState] = useState<"idle" | "busy" | "ok" | "err">("idle");
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState("");
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  /* your photo: shown instead of your initials everywhere (SQL 158) */
  useAvatars();
  const photoIn = useRef<HTMLInputElement>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoOver, setPhotoOver] = useState(false);
  const [photoErr, setPhotoErr] = useState<string | null>(null);
  const putPhoto = async (file: File | undefined) => {
    if (!file || !me || photoBusy) return;
    setPhotoBusy(true); setPhotoErr(null);
    const r = await uploadMyAvatar(me.id, file);
    setPhotoBusy(false);
    if (r.error) setPhotoErr(r.error);
  };
  const dropPhoto = async () => {
    if (!me || photoBusy) return;
    setPhotoBusy(true); setPhotoErr(null);
    const e = await removeMyAvatar(me.id);
    setPhotoBusy(false);
    if (e) setPhotoErr(e);
  };
  const hasPhoto = !!avatarUrl(me?.id);
  const fromLinkedIn = async () => {
    if (!me || photoBusy) return;
    setPhotoBusy(true); setPhotoErr(null);
    const r = await linkedInAvatar(me.id);
    setPhotoBusy(false);
    if (r.error) setPhotoErr(r.error);
  };

  useEffect(() => {
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      const uid = u?.user?.id; if (!uid) return;
      let { data, error } = await supabase.from("profiles").select("id, first_name, last_name, phone, job_title, linkedin_url, email, role, security_level, is_org_superadmin, tenant_id").eq("id", uid).maybeSingle();
      if (error && /linkedin_url/.test(error.message)) ({ data } = await supabase.from("profiles").select("id, first_name, last_name, phone, job_title, email, role, security_level, is_org_superadmin, tenant_id").eq("id", uid).maybeSingle());
      const m = { ...(data as any), email: (data as any)?.email ?? u.user?.email ?? "" } as Me;
      setMe(m);
      setForm({ first_name: m.first_name ?? "", last_name: m.last_name ?? "", phone: m.phone ?? "", job_title: m.job_title ?? "", linkedin_url: m.linkedin_url ?? "" });
    })();
  }, []);
  const dirty = !!me && (form.first_name !== (me.first_name ?? "") || form.last_name !== (me.last_name ?? "") || form.phone !== (me.phone ?? "") || form.job_title !== (me.job_title ?? "") || form.linkedin_url !== (me.linkedin_url ?? ""));
  const saveMe = async () => {
    if (!me) return;
    setSaveState("busy");
    const li = form.linkedin_url.trim();
    const patch = { first_name: form.first_name.trim() || null, last_name: form.last_name.trim() || null, phone: form.phone.trim() || null, job_title: form.job_title.trim() || null,
      linkedin_url: li ? (/^https?:\/\//i.test(li) ? li : `https://${li.replace(/^\/+/, "")}`) : null };
    const { error } = await supabase.from("profiles").update(patch).eq("id", me.id);
    if (error) { setSaveState("err"); return; }
    setMe({ ...me, ...patch }); setSaveState("ok");
    window.setTimeout(() => setSaveState("idle"), 2200);
  };
  const changePw = async () => {
    const p = passwordProblem(pw);
    if (p) { setPwMsg({ ok: false, text: p }); return; }
    if (pw !== pw2) { setPwMsg({ ok: false, text: "The two passwords don't match." }); return; }
    const { error } = await supabase.auth.updateUser({ password: pw });
    if (error) { setPwMsg({ ok: false, text: error.message }); return; }
    setPw(""); setPw2(""); setPwMsg({ ok: true, text: "Password updated." });
  };

  // the company part (plan, billing entities, invoices) is the owner's: role boss
  const isManager = !!me && (me.role ?? "").toLowerCase() === "boss";
  const name = me ? [me.first_name, me.last_name].filter(Boolean).join(" ") || me.email || "" : "";

  return (
    <div className="st ya">
      <header className="ya-head">
        <button type="button" className="ya-back" onClick={onBack} aria-label="Back to Settings">{I.back}</button>
        <div><h1>Your account</h1><p>{isManager ? "You, and the company you manage" : "Your details, your password and your session"}</p></div>
      </header>

      <div className={`ya-grid ${isManager ? "is-two" : ""}`}>
        {/* ---------------- you ---------------- */}
        <div className="ya-col">
          <section className="ya-card ya-me" style={{ ["--a" as string]: "#12b57f" }}>
            <div className="ya-me-top">
              <button type="button" className={`ya-av ya-photo ${photoBusy ? "is-busy" : ""} ${photoOver ? "is-over" : ""} ${hasPhoto ? "has-photo" : ""}`}
                onClick={() => photoIn.current?.click()} disabled={!me} title={hasPhoto ? "Change your photo" : "Put a photo instead of your initials"} aria-label={hasPhoto ? "Change your photo" : "Add a photo"}
                onDragOver={(e) => { if (!e.dataTransfer.types.includes("Files")) return; e.preventDefault(); setPhotoOver(true); }}
                onDragLeave={() => setPhotoOver(false)}
                onDrop={(e) => { e.preventDefault(); setPhotoOver(false); void putPhoto(e.dataTransfer.files?.[0]); }}>
                <PicOr id={me?.id}>{me ? initials(form.first_name, form.last_name, me.email ?? "") : ""}</PicOr>
                <span className="ya-photo-cam" aria-hidden="true">{I.camera}</span>
              </button>
              <input ref={photoIn} type="file" accept="image/*" hidden onChange={(e) => { void putPhoto(e.target.files?.[0]); e.target.value = ""; }} />
              <div className="ya-me-txt">
                <b>{name || "…"}</b>
                <small>{me?.email}</small>
                <span className="ya-photo-acts">
                  <button type="button" onClick={() => photoIn.current?.click()} disabled={!me || photoBusy}>{photoBusy ? "Saving…" : hasPhoto ? "Change photo" : "Add a photo"}</button>
                  <button type="button" className="is-li" onClick={() => void fromLinkedIn()} disabled={!me || photoBusy} title="Signs in with LinkedIn (the first time) and takes your LinkedIn photo">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM3 9.75h4V21H3zM9.5 9.75h3.8v1.6h.06c.53-1 1.83-2.05 3.77-2.05 4.03 0 4.77 2.65 4.77 6.1V21h-4v-5c0-1.2-.02-2.73-1.66-2.73-1.67 0-1.92 1.3-1.92 2.64V21h-4z" /></svg>
                    Use my LinkedIn photo
                  </button>
                  {hasPhoto && !photoBusy && <button type="button" className="is-del" onClick={() => void dropPhoto()}>Remove</button>}
                </span>
                {photoErr && <em className="ya-photo-err">{photoErr}</em>}
              </div>
              {me && <span className="ya-chip">{levelName(me.security_level ?? me.role ?? "") || "—"}</span>}
            </div>
            <div className="ya-fields">
              <label><span>First name</span><input value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} autoComplete="given-name" /></label>
              <label><span>Last name</span><input value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} autoComplete="family-name" /></label>
              <label><span>Phone</span><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+34 600 000 000" inputMode="tel" autoComplete="tel" /></label>
              <label><span>Job title</span><input value={form.job_title} onChange={(e) => setForm({ ...form, job_title: e.target.value })} placeholder="e.g. Sales manager" /></label>
              <label className="is-wide"><span>LinkedIn</span><input value={form.linkedin_url} onChange={(e) => setForm({ ...form, linkedin_url: e.target.value })} placeholder="linkedin.com/in/your-name" inputMode="url" autoComplete="url" /></label>
              <label className="is-wide"><span>E-mail</span><input value={me?.email ?? ""} disabled /><em>Your sign-in e-mail — ask your boss or Next to change it.</em></label>
            </div>
            <div className="ya-actions">
              {saveState === "ok" && <span className="ya-ok">Saved</span>}
              {saveState === "err" && <span className="ya-err">Couldn't save — try again</span>}
              <button type="button" className="ya-btn is-go" disabled={!dirty || saveState === "busy"} onClick={() => void saveMe()}>{saveState === "busy" ? "Saving…" : "Save changes"}</button>
            </div>
          </section>

          <section className="ya-card" style={{ ["--a" as string]: "#6366f1" }}>
            <div className="ya-card-h"><span className="ya-ico">{I.lock}</span><div><b>Password</b><small>{PASSWORD_HINT}</small></div></div>
            <div className="ya-fields">
              <label><span>New password</span><input type="password" value={pw} onChange={(e) => { setPw(e.target.value); setPwMsg(null); }} autoComplete="new-password" /></label>
              <label><span>Repeat it</span><input type="password" value={pw2} onChange={(e) => { setPw2(e.target.value); setPwMsg(null); }} autoComplete="new-password" /></label>
            </div>
            <div className="ya-actions">
              {pwMsg && <span className={pwMsg.ok ? "ya-ok" : "ya-err"}>{pwMsg.text}</span>}
              <button type="button" className="ya-btn" disabled={!pw || !pw2} onClick={() => void changePw()}>Update password</button>
            </div>
          </section>

          <section className="ya-card ya-out" style={{ ["--a" as string]: "#e5484d" }}>
            <span className="ya-ico">{I.out}</span>
            <div><b>Sign out</b><small>Close your session on this device. Other tabs and devices stay signed in.</small></div>
            <button type="button" className="ya-btn is-danger" onClick={async () => { await supabase.auth.signOut({ scope: "local" }).catch(() => {}); window.location.assign("/login"); }}>Sign out</button>
          </section>
        </div>

        {/* ---------------- your company ---------------- */}
        {isManager && me?.tenant_id && <Company tenantId={me.tenant_id} />}
      </div>
    </div>
  );
}

/* ===================================================================== */
function Company({ tenantId }: { tenantId: string }) {
  const [tenant, setTenant] = useState<{ name: string; plan: string | null; max_users: number | null } | null>(null);
  const [activeUsers, setActiveUsers] = useState<number | null>(null);
  const [entities, setEntities] = useState<Entity[] | null>(null);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [notReady, setNotReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<(Omit<Entity, "id"> & { id?: string }) | null>(null);
  const [ask, setAsk] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // the change history (SQL 138), and when you had last looked before this visit: Next's changes after it are new
  const [events, setEvents] = useState<BillingEvent[] | null>(null);
  const [since, setSince] = useState<string | null | undefined>(undefined);
  const sinceRef = useRef<string | null | undefined>(undefined);

  const load = async () => {
    const [t, u, b] = await Promise.all([
      supabase.from("tenants").select("name, plan, max_users").eq("id", tenantId).maybeSingle(),
      supabase.from("profiles").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).neq("active", false),
      loadBilling(tenantId),
    ]);
    setTenant((t.data as any) ?? null);
    setActiveUsers(u.count ?? null);
    if (b.notReady) { setNotReady(true); setEntities([]); setInvoices([]); setEvents([]); return; }
    setEntities(b.entities as Entity[]);
    setInvoices(b.invoices as Invoice[]);
    setEvents(b.noEvents ? null : b.events);
    if (sinceRef.current === undefined) { sinceRef.current = b.seenAt; setSince(b.seenAt); }
    if (!b.noEvents) void markBillingSeen(tenantId).catch(() => {});
  };
  useEffect(() => {
    void load();
    return watchBilling(tenantId, () => void load());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);
  const fresh = useMemo(() => (events && since !== undefined ? unseenOf(events, "next", since) : []), [events, since]);
  const freshRefs = useMemo(() => new Set(fresh.map((e) => e.ref_id)), [fresh]);

  const saveEntity = async () => {
    if (!edit || !edit.legal_name.trim() || !edit.tax_id.trim()) return;
    setBusy(true); setErr(null);
    const row: any = { ...edit, legal_name: edit.legal_name.trim(), tax_id: edit.tax_id.trim().toUpperCase().replace(/\s+/g, "") };
    for (const k of ["email", "phone", "street", "postal_code", "city", "province", "country", "iban", "po_reference"]) row[k] = (row[k] ?? "").toString().trim() || null;
    if (row.iban) row.iban = row.iban.toUpperCase().replace(/\s+/g, " ");
    if (!entities?.length) row.is_default = true;
    const id = row.id; delete row.id;
    const { error } = id ? await supabase.from("tenant_billing_entities").update(row).eq("id", id) : await supabase.from("tenant_billing_entities").insert(row);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setEdit(null); void load();
  };
  const makeDefault = async (id: string) => { await supabase.from("tenant_billing_entities").update({ is_default: true }).eq("id", id); void load(); };
  const remove = async (id: string) => {
    setAsk(null);
    const { error } = await supabase.from("tenant_billing_entities").delete().eq("id", id);
    if (error) { setErr(error.message); return; }
    void load();
  };

  const last = invoices?.[0] ?? null;
  const paidTotal = useMemo(() => (invoices ?? []).filter((x) => x.status === "paid").reduce((s, x) => s + x.total, 0), [invoices]);
  const seats = tenant?.max_users ?? null;
  const used = activeUsers ?? 0;
  const entityName = (id: string | null) => entities?.find((x) => x.id === id)?.legal_name ?? null;

  return (
    <div className="ya-col">
      {/* what Next changed since you last looked */}
      {fresh.length > 0 && (
        <section className="ya-news" role="status">
          <span className="ya-news-ico">{I.bell}</span>
          <div className="ya-news-txt">
            <b>Next updated your billing</b>
            <ul>
              {fresh.slice(0, 4).map((e) => { const t = eventText(e); return <li key={e.id}><span>{t.what.charAt(0).toUpperCase() + t.what.slice(1)}{t.detail && <em> · {t.detail}</em>}</span><i>{billingAgo(e.created_at)}</i></li>; })}
              {fresh.length > 4 && <li className="is-more"><span>and {fresh.length - 4} more below</span></li>}
            </ul>
          </div>
          <button type="button" className="ya-btn is-sm is-ghost" onClick={() => { const now = new Date().toISOString(); sinceRef.current = now; setSince(now); }}>Got it</button>
        </section>
      )}

      {/* plan */}
      <section className="ya-card ya-plan" style={{ ["--a" as string]: "#0a6f4d" }}>
        <div className="ya-plan-top">
          <span className="ya-ico is-pine">{I.building}</span>
          <div><small>Your company</small><b>{tenant?.name ?? "…"}</b></div>
          <span className="ya-plan-tag">{I.spark}{PLAN[tenant?.plan ?? "base"] ?? tenant?.plan ?? "Base"}</span>
        </div>
        <div className="ya-plan-figs">
          <div><small>Users</small><b>{used}{seats ? <em> / {seats}</em> : null}</b>
            {seats ? <span className="ya-bar"><i style={{ width: `${Math.min(100, (used / Math.max(1, seats)) * 100)}%` }} /></span> : null}
          </div>
          <div><small>Per user / month</small><b>{last ? money(last.price_per_user, last.currency) : "—"}</b>{last && last.discount_pct > 0 && <span className="ya-disc">−{last.discount_pct}%</span>}</div>
          <div><small>Last invoice</small><b>{last ? money(last.total, last.currency) : "—"}</b><span className="ya-sub">{last ? day(last.issued_on) : "None yet"}</span></div>
          <div><small>Paid so far</small><b>{money(paidTotal, last?.currency)}</b><span className="ya-sub">{(invoices ?? []).length} invoice{(invoices ?? []).length === 1 ? "" : "s"}</span></div>
        </div>
      </section>

      {notReady && <p className="ya-note">Company billing isn't switched on yet: run <code>src/base/sql/137_tenant_billing.sql</code> in Supabase.</p>}

      {/* billed as */}
      <section className="ya-card" style={{ ["--a" as string]: "#3b82f6" }}>
        <div className="ya-card-h">
          <span className="ya-ico">{I.doc}</span>
          <div><b>Billed as</b><small>The legal entities and tax IDs Next can invoice. The starred one is used unless you ask otherwise.</small></div>
          {!edit && !notReady && <button type="button" className="ya-btn is-sm" onClick={() => { setEdit({ ...EMPTY_ENTITY }); setErr(null); }}>{I.plus}Add</button>}
        </div>

        {edit && (
          <div className="ya-ent-form">
            <div className="ya-fields">
              <label><span>Legal name *</span><input autoFocus value={edit.legal_name} onChange={(e) => setEdit({ ...edit, legal_name: e.target.value })} placeholder="Company SL" /></label>
              <label><span>Tax ID (CIF / VAT) *</span><input value={edit.tax_id} onChange={(e) => setEdit({ ...edit, tax_id: e.target.value })} placeholder="ESB12345678" /></label>
              <label><span>Billing e-mail</span><input value={edit.email ?? ""} onChange={(e) => setEdit({ ...edit, email: e.target.value })} placeholder="billing@company.com" /></label>
              <label><span>Phone</span><input value={edit.phone ?? ""} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></label>
              <label className="is-wide"><span>Address</span><input value={edit.street ?? ""} onChange={(e) => setEdit({ ...edit, street: e.target.value })} placeholder="Street and number" /></label>
              <label><span>Postal code</span><input value={edit.postal_code ?? ""} onChange={(e) => setEdit({ ...edit, postal_code: e.target.value })} /></label>
              <label><span>City</span><input value={edit.city ?? ""} onChange={(e) => setEdit({ ...edit, city: e.target.value })} /></label>
              <label><span>Province</span><input value={edit.province ?? ""} onChange={(e) => setEdit({ ...edit, province: e.target.value })} /></label>
              <label><span>Country</span><input value={edit.country ?? ""} onChange={(e) => setEdit({ ...edit, country: e.target.value })} /></label>
              <label><span>IBAN (direct debit)</span><input value={edit.iban ?? ""} onChange={(e) => setEdit({ ...edit, iban: e.target.value })} placeholder="ES00 0000 0000 0000 0000 0000" /></label>
              <label><span>PO / reference</span><input value={edit.po_reference ?? ""} onChange={(e) => setEdit({ ...edit, po_reference: e.target.value })} placeholder="On every invoice" /></label>
            </div>
            <div className="ya-actions">
              <button type="button" className={`ya-check ${edit.is_default ? "is-on" : ""}`} onClick={() => setEdit({ ...edit, is_default: !edit.is_default })}><i>{I.star}</i>Use by default</button>
              <span className="ya-grow" />
              <button type="button" className="ya-btn is-ghost" onClick={() => { setEdit(null); setErr(null); }}>Cancel</button>
              <button type="button" className="ya-btn is-go" disabled={busy || !edit.legal_name.trim() || !edit.tax_id.trim()} onClick={() => void saveEntity()}>{busy ? "Saving…" : edit.id ? "Save" : "Add entity"}</button>
            </div>
          </div>
        )}
        {err && <p className="ya-err is-block">{err}</p>}

        <div className="ya-ents">
          {entities === null && <div className="ya-skel"><i /><i /></div>}
          {entities?.length === 0 && !edit && !notReady && <p className="ya-empty">No billing entity yet. Add the company name and tax ID your invoices should carry.</p>}
          {entities?.map((x) => (
            <div key={x.id} className={`ya-ent ${x.is_default ? "is-default" : ""} ${freshRefs.has(x.id) ? "is-new" : ""}`}>
              <button type="button" className="ya-star" aria-label={x.is_default ? "Default entity" : "Use by default"} title={x.is_default ? "Used by default" : "Use by default"} onClick={() => !x.is_default && void makeDefault(x.id)}>{I.star}</button>
              <div className="ya-ent-txt">
                <b>{x.legal_name}{freshRefs.has(x.id) && <i className="ya-new">Updated by Next</i>}</b>
                <span className="ya-tax">{x.tax_id}</span>
                <small>{[x.street, [x.postal_code, x.city].filter(Boolean).join(" "), x.province, x.country].filter(Boolean).join(" · ") || "No address yet"}</small>
                {(x.email || x.iban || x.po_reference) && <small>{[x.email, x.iban && `IBAN ${x.iban.slice(0, 4)} ···· ${x.iban.replace(/\s+/g, "").slice(-4)}`, x.po_reference && `Ref. ${x.po_reference}`].filter(Boolean).join(" · ")}</small>}
              </div>
              {ask === x.id ? (
                <span className="ya-ask">Remove? <button className="is-yes" onClick={() => void remove(x.id)}>Yes</button><button onClick={() => setAsk(null)}>No</button></span>
              ) : (
                <span className="ya-ent-act">
                  <button type="button" aria-label="Edit" onClick={() => { setEdit({ ...x }); setErr(null); }}>{I.edit}</button>
                  <button type="button" aria-label="Remove" className="is-del" onClick={() => setAsk(x.id)}>{I.trash}</button>
                </span>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* history */}
      <section className="ya-card" style={{ ["--a" as string]: "#e0a13c" }}>
        <div className="ya-card-h"><span className="ya-ico">{I.down}</span><div><b>Billing history</b><small>What Next has billed you for the CRM. Click an invoice for the detail.</small></div></div>
        {invoices === null && <div className="ya-skel"><i /><i /><i /></div>}
        {invoices?.length === 0 && <p className="ya-empty">No invoices yet. They appear here as soon as Next bills you.</p>}
        {!!invoices?.length && (
          <div className="ya-inv">
            <div className="ya-inv-h"><span>Date</span><span>Invoice</span><span>Billed to</span><span className="is-r">Users</span><span className="is-r">Total</span><span>Status</span></div>
            {invoices.map((v) => {
              const on = open === v.id;
              // price_per_user is per month: an invoice for a quarter or a year counts its months
              const months = v.period_start && v.period_end ? Math.max(1, Math.round((new Date(v.period_end).getTime() - new Date(v.period_start).getTime()) / 86400000 / 30.44)) : 1;
              const gross = v.users * v.price_per_user * months;
              const discount = Math.max(0, gross - v.net);
              return (
                <div key={v.id} className={`ya-inv-row ${on ? "is-open" : ""} ${freshRefs.has(v.id) ? "is-new" : ""}`}>
                  <button type="button" className="ya-inv-line" aria-expanded={on} onClick={() => setOpen(on ? null : v.id)}>
                    <span>{day(v.issued_on)}</span>
                    <span className="ya-num">{v.number}{freshRefs.has(v.id) && <i className="ya-new">New</i>}</span>
                    <span className="ya-to"><b>{v.bill_to_name ?? entityName(v.entity_id) ?? "—"}</b><small>{v.bill_to_tax_id ?? ""}</small></span>
                    <span className="is-r">{v.users}</span>
                    <span className="is-r ya-tot">{money(v.total, v.currency)}</span>
                    <span><i className={`ya-st is-${v.status}`}>{STATUS[v.status]}</i></span>
                  </button>
                  <div className="ya-inv-fold"><div className="ya-inv-in">
                    <dl className="ya-facts">
                      <div><dt>Period</dt><dd>{v.period_start ? `${day(v.period_start)} – ${day(v.period_end)}` : "—"}</dd></div>
                      <div><dt>Plan</dt><dd>{PLAN[v.plan ?? ""] ?? v.plan ?? "—"}</dd></div>
                      <div><dt>Due</dt><dd>{day(v.due_on)}</dd></div>
                      <div><dt>Paid</dt><dd>{day(v.paid_on)}</dd></div>
                      <div className="is-wide"><dt>Billed to</dt><dd>{[v.bill_to_name, v.bill_to_tax_id].filter(Boolean).join(" · ") || "—"}{v.bill_to_address ? <small>{v.bill_to_address}</small> : null}</dd></div>
                    </dl>
                    <div className="ya-calc">
                      {(v.lines?.length ? v.lines : [{ label: `${v.users} user${v.users === 1 ? "" : "s"} × ${money(v.price_per_user, v.currency)}${months > 1 ? ` × ${months} months` : " / month"}`, amount: gross }]).map((l, k) => (
                        <div key={k}><span>{l.label}</span><b>{money(l.amount, v.currency)}</b></div>
                      ))}
                      {v.discount_pct > 0 && <div className="is-disc"><span>Discount {v.discount_pct}%</span><b>−{money(discount, v.currency)}</b></div>}
                      <div className="is-sub"><span>Net</span><b>{money(v.net, v.currency)}</b></div>
                      <div><span>VAT {v.vat_pct}%</span><b>{money(v.vat, v.currency)}</b></div>
                      <div className="is-total"><span>Total</span><b>{money(v.total, v.currency)}</b></div>
                    </div>
                    {(v.notes || v.pdf_url) && (
                      <div className="ya-inv-foot">
                        {v.notes && <p>{v.notes}</p>}
                        {v.pdf_url && <a className="ya-btn is-sm" href={v.pdf_url} target="_blank" rel="noreferrer">{I.down}Download PDF</a>}
                      </div>
                    )}
                  </div></div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* every change, from both sides */}
      {events && events.length > 0 && (
        <section className="ya-card" style={{ ["--a" as string]: "#0c875f" }}>
          <div className="ya-card-h"><span className="ya-ico">{I.history}</span><div><b>Changes</b><small>What you and Next changed in your billing, newest first.</small></div></div>
          <ol className="ya-feed">
            {events.slice(0, 12).map((e) => {
              const t = eventText(e);
              const isNew = fresh.some((x) => x.id === e.id);
              return (
                <li key={e.id} className={`is-${e.side} ${isNew ? "is-new" : ""}`}>
                  <span className="ya-feed-dot" aria-hidden="true">{e.kind.startsWith("invoice") ? I.doc : I.building}</span>
                  <div>
                    <p><b>{e.side === "next" ? "Next" : e.actor_name ?? "Your company"}</b> {t.what}{t.detail && <em> — {t.detail}</em>}</p>
                    <small><span className={`ya-side is-${e.side}`}>{e.side === "next" ? "Next" : "Your company"}</span>{billingAgo(e.created_at)}{isNew && <i className="ya-new">New</i>}</small>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </div>
  );
}
