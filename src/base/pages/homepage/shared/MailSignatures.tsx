/**
 * E-mail signatures: each person's own, kept in Next (table mail_signatures, SQL 156).
 *
 * Paste one (copied from Outlook, Gmail, a web page: its formatting and pictures come along), write one, or
 * bring it from Outlook: outlook-sync reads the signature at the end of the e-mails you sent lately (Graph
 * has no endpoint for Outlook's signature settings). One is the default: a reply sent by e-mail from a
 * ticket ends with it, and the box to write in lets you pick another or none.
 * Pictures stay inside the HTML (data: URIs); outlook-sync sends them as inline attachments.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../../../components/api/supabase";
import { findOutlookSignatures, type FoundSignature } from "../../../api/outlookSync";
import "./MailSignatures.css";

export interface MailSignature { id: string; name: string; html: string; isDefault: boolean }

const EVT = "mail-signatures-changed";
let cache: MailSignature[] | null = null;
let inflight: Promise<MailSignature[]> | null = null;

async function myId(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.user?.id ?? null;
}
export async function loadSignatures(force = false): Promise<MailSignature[]> {
  if (cache && !force) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const uid = await myId();
    if (!uid) return [];
    const { data, error } = await supabase.from("mail_signatures").select("id, name, html, is_default, created_at").eq("user_id", uid).order("created_at");
    if (error) return [];
    cache = (data ?? []).map((r: any) => ({ id: r.id, name: r.name ?? "Signature", html: r.html ?? "", isDefault: !!r.is_default }));
    return cache;
  })();
  try { return await inflight; } finally { inflight = null; }
}
const changed = () => { cache = null; window.dispatchEvent(new Event(EVT)); };

/** Your signatures (null while loading); follows changes made anywhere on the page. */
export function useSignatures(): MailSignature[] | null {
  const [list, setList] = useState<MailSignature[] | null>(cache);
  useEffect(() => {
    let alive = true;
    const go = () => { void loadSignatures().then((l) => { if (alive) setList([...l]); }); };
    go();
    window.addEventListener(EVT, go);
    return () => { alive = false; window.removeEventListener(EVT, go); };
  }, []);
  return list;
}

const sqlMissing = (m: string) => /mail_signatures/.test(m) && /does not exist|schema cache|Could not find/i.test(m);
async function saveSignature(s: { id?: string; name: string; html: string; isDefault: boolean }): Promise<{ id: string | null; error: string | null }> {
  const uid = await myId();
  if (!uid) return { id: null, error: "Not signed in." };
  if (s.isDefault) {
    let q = supabase.from("mail_signatures").update({ is_default: false }).eq("user_id", uid).eq("is_default", true);
    if (s.id) q = q.neq("id", s.id);
    const { error } = await q;
    if (error) return { id: null, error: sqlMissing(error.message) ? "Signatures need SQL 156 first." : error.message };
  }
  const row = { name: s.name.trim() || "Signature", html: s.html, is_default: s.isDefault, updated_at: new Date().toISOString() };
  const res = s.id
    ? await supabase.from("mail_signatures").update(row).eq("id", s.id).select("id").single()
    : await supabase.from("mail_signatures").insert({ ...row, user_id: uid }).select("id").single();
  if (res.error) return { id: null, error: sqlMissing(res.error.message) ? "Signatures need SQL 156 first." : res.error.message };
  changed();
  return { id: (res.data as any)?.id ?? s.id ?? null, error: null };
}
async function deleteSignature(id: string): Promise<string | null> {
  const { error } = await supabase.from("mail_signatures").delete().eq("id", id);
  if (error) return error.message;
  changed();
  return null;
}

/** Keeps a signature's look (inline styles, tables, pictures) and drops what could run or leak:
 *  scripts, styles, frames, forms, event handlers, javascript: links, pictures from the disk. */
export function cleanSignature(html: string): string {
  if (typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild as HTMLElement | null;
  if (!root) return "";
  root.querySelectorAll("script, style, iframe, frame, object, embed, meta, link, title, xml, form, input, button, textarea, select, base").forEach((e) => e.remove());
  const walk = doc.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const notes: Node[] = [];
  while (walk.nextNode()) notes.push(walk.currentNode);
  notes.forEach((n) => n.parentNode?.removeChild(n));
  root.querySelectorAll("*").forEach((el) => {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      if (n.startsWith("on") || n === "class" || n === "id" || n === "contenteditable" || n === "srcset") el.removeAttribute(a.name);
      else if ((n === "href" || n === "src" || n === "action") && /^\s*(javascript|vbscript|data:text)/i.test(a.value)) el.removeAttribute(a.name);
    }
    if (el.tagName === "IMG" && /^\s*(file|cid|blob):/i.test(el.getAttribute("src") ?? "")) el.remove();
    if (el.tagName === "A") { el.setAttribute("target", "_blank"); el.setAttribute("rel", "noopener noreferrer"); }
    if (/^[a-z]+:[a-z0-9]+$/i.test(el.tagName)) el.replaceWith(...el.childNodes);   // <o:p> and friends
  });
  return root.innerHTML.replace(/(<p>\s*(&nbsp;|\s)*<\/p>\s*)+$/i, "").trim();
}
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

const Ico = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const I_PEN = "M4 20c3-1 4.5-2.5 6-5M14.5 4.5l5 5L10 19l-6 1 1-6z";
const I_X = "M6 6l12 12M18 6L6 18";
const I_PLUS = "M12 5v14M5 12h14";
const I_OUT = "M4 6h10v12H4zM14 9l6-3v12l-6-3M7 10h4M7 14h4";
const I_TRASH = "M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3";

/** The window: your signatures on the left, the one you're on to the right (or what was found in Outlook). */
export function SignatureManager({ onClose, startId }: { onClose: () => void; startId?: string | null }) {
  const list = useSignatures();
  const [selId, setSelId] = useState<string | "new" | "outlook" | null>(startId ?? null);
  const [name, setName] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [found, setFound] = useState<FoundSignature[] | null>(null);
  const [finding, setFinding] = useState(false);
  const edRef = useRef<HTMLDivElement>(null);
  const sel = list?.find((s) => s.id === selId) ?? null;

  // start on the default one (or a new one when there's none yet)
  useEffect(() => {
    if (!list || selId) return;
    setSelId(list.find((s) => s.isDefault)?.id ?? list[0]?.id ?? "new");
  }, [list, selId]);
  // the editor follows the signature picked (once per pick: saving doesn't wipe what's typed)
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (selId === "outlook" || selId === null) { shown.current = null; return; }
    if (!edRef.current || shown.current === selId) return;
    const s = list?.find((x) => x.id === selId) ?? null;
    if (selId !== "new" && !s) return;   // just saved: wait for the list
    shown.current = selId;
    setName(s?.name ?? (list?.length ? "New signature" : "My signature"));
    setIsDefault(s ? s.isDefault : !list?.some((x) => x.isDefault));
    edRef.current.innerHTML = s ? cleanSignature(s.html) : "";
    setErr(null);
  }, [selId, list]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [onClose]);

  const askOutlook = async () => {
    setSelId("outlook"); setFinding(true); setErr(null); setFound(null);
    const r = await findOutlookSignatures();
    setFinding(false);
    if (r.error) { setErr(r.error); setFound([]); return; }
    setFound(r.signatures.map((x) => ({ ...x, html: cleanSignature(x.html) })).filter((x) => textOf(x.html) || /<img/i.test(x.html)));
  };
  const take = async (f: FoundSignature) => {
    setBusy(true);
    const taken = new Set((list ?? []).map((s) => s.name));
    let nm = "Outlook";
    for (let i = 2; taken.has(nm); i++) nm = `Outlook ${i}`;
    const r = await saveSignature({ name: nm, html: f.html, isDefault: !list?.some((s) => s.isDefault) });
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    setSelId(r.id);
  };
  const save = async () => {
    const html = cleanSignature(edRef.current?.innerHTML ?? "");
    if (!textOf(html) && !/<img/i.test(html)) { setErr("Paste or write the signature first."); return; }
    setBusy(true);
    const r = await saveSignature({ id: sel?.id, name, html, isDefault });
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    setErr(null);
    setSelId(r.id);
  };
  const remove = async () => {
    if (!sel) return;
    setBusy(true);
    const e = await deleteSignature(sel.id);
    setBusy(false);
    if (e) { setErr(e); return; }
    setSelId(null);
  };
  // a picture pasted on its own (a logo copied as an image) goes in as a data: URI
  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const file = [...e.clipboardData.items].find((x) => x.kind === "file" && x.type.startsWith("image/"))?.getAsFile();
    if (file && !e.clipboardData.getData("text/html")) {
      e.preventDefault();
      if (file.size > 300_000) { setErr("That picture is too big for a signature (keep it under 300 KB)."); return; }
      const rd = new FileReader();
      rd.onload = () => document.execCommand("insertHTML", false, `<img src="${rd.result}" alt="" style="max-width:240px">`);
      rd.readAsDataURL(file);
      return;
    }
    const html = e.clipboardData.getData("text/html");
    if (html) {
      e.preventDefault();
      document.execCommand("insertHTML", false, cleanSignature(html.replace(/^[\s\S]*<!--StartFragment-->|<!--EndFragment-->[\s\S]*$/g, "")));
    }
  };

  return createPortal(
    <div className="msig-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="msig" role="dialog" aria-label="E-mail signatures">
        <header className="msig-h">
          <span className="msig-ico"><Ico d={I_PEN} /></span>
          <span className="msig-t"><b>E-mail signatures</b><small>Added at the end of the e-mails you send from a ticket.</small></span>
          <button type="button" className="msig-x" onClick={onClose} aria-label="Close"><Ico d={I_X} /></button>
        </header>
        <div className="msig-body">
          <aside className="msig-list" aria-label="Your signatures">
            {list === null ? <div className="msig-skel" /> : list.map((s) => (
              <button key={s.id} type="button" className={`msig-item ${selId === s.id ? "is-on" : ""}`} onClick={() => setSelId(s.id)}>
                <b>{s.name}</b>
                {s.isDefault && <em>Default</em>}
                <small>{textOf(s.html).slice(0, 60) || "Picture"}</small>
              </button>
            ))}
            <button type="button" className={`msig-item is-add ${selId === "new" ? "is-on" : ""}`} onClick={() => setSelId("new")}><Ico d={I_PLUS} />New signature</button>
            <button type="button" className={`msig-item is-add is-outlook ${selId === "outlook" ? "is-on" : ""}`} onClick={() => void askOutlook()}><Ico d={I_OUT} />Bring from Outlook</button>
          </aside>
          <section className="msig-main">
            {selId === "outlook" ? (
              <div className="msig-found">
                <p className="msig-lead">Signatures found at the end of the e-mails you sent lately. Pick the one to keep.</p>
                {finding ? <div className="msig-skel is-big"><span>Reading what you sent lately…</span></div>
                  : found && found.length ? found.map((f, i) => (
                    <article key={i} className="msig-card">
                      <div className="msig-prev" dangerouslySetInnerHTML={{ __html: f.html }} />
                      <footer>
                        <span>{f.sentAt ? `In an e-mail of ${new Date(f.sentAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : "In a sent e-mail"}</span>
                        <button type="button" className="msig-primary" disabled={busy} onClick={() => void take(f)}>Use this one</button>
                      </footer>
                    </article>
                  )) : !err && (
                    <div className="msig-empty">
                      <b>No signature found</b>
                      <span>None of your last 30 sent e-mails ends with an Outlook signature. Open it in Outlook (Settings › Signatures), copy it and paste it into a new signature here.</span>
                      <button type="button" className="msig-soft" onClick={() => setSelId("new")}><Ico d={I_PLUS} />New signature</button>
                    </div>
                  )}
              </div>
            ) : (
              <div className="msig-edit">
                <label className="msig-field">
                  <span>Name</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Full, Short, Spanish" maxLength={60} />
                </label>
                <div className="msig-field">
                  <span>Signature</span>
                  <div ref={edRef} className="msig-ed" contentEditable suppressContentEditableWarning onPaste={onPaste}
                    data-ph="Paste your signature here (copy it from Outlook › Settings › Signatures), or write it" />
                </div>
                <label className="msig-switch">
                  <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} /><i aria-hidden="true" />
                  <span><b>Use it by default</b><small>Replies by e-mail end with it unless you pick another.</small></span>
                </label>
              </div>
            )}
            {err && <p className="msig-err">{err}</p>}
          </section>
        </div>
        {selId !== "outlook" && (
          <footer className="msig-f">
            {sel && <button type="button" className="msig-del" disabled={busy} onClick={() => void remove()}><Ico d={I_TRASH} />Delete</button>}
            <span className="msig-spacer" />
            <button type="button" className="msig-soft" onClick={onClose}>Close</button>
            <button type="button" className="msig-primary" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : sel ? "Save" : "Add signature"}</button>
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
