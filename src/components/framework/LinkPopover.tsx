// Adding a link in a rich-text e-mail editor (Customer success blueprints, Marketing campaigns).
// Text selected: the link goes on that text. Nothing selected: you choose — the address itself, or a text you write.
import { useEffect, useRef, useState } from "react";
import "./LinkPopover.css";

export interface LinkTarget { range: Range | null; text: string }

/** Where the link goes: the selection inside `root` (if any) and its text. Call it before focus leaves the editor. */
export function captureLinkTarget(root: HTMLElement | null, saved?: Range | null): LinkTarget {
  const sel = window.getSelection();
  let r: Range | null = null;
  if (root && sel && sel.rangeCount && root.contains(sel.getRangeAt(0).commonAncestorContainer)) r = sel.getRangeAt(0).cloneRange();
  else if (root && saved && root.contains(saved.commonAncestorContainer)) r = saved.cloneRange();
  return { range: r, text: r ? r.toString() : "" };
}

/** "acme.com" → "https://acme.com", "ana@acme.com" → "mailto:ana@acme.com"; {{fields}} and full links stay as they are. */
export function normalizeLink(u: string): string {
  const v = u.trim();
  if (!v || /^(https?:|mailto:|tel:|\{\{)/i.test(v)) return v;
  if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(v)) return `mailto:${v}`;
  return `https://${v.replace(/^\/+/, "")}`;
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Puts the link in the editor: on the selected text, else as new text at the cursor (or the end). */
export function placeLink(root: HTMLElement, target: LinkTarget, url: string, text: string) {
  const href = normalizeLink(url);
  if (!href) return;
  root.focus();
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  if (target.range) sel.addRange(target.range);
  else { const r = document.createRange(); r.selectNodeContents(root); r.collapse(false); sel.addRange(r); }
  if (target.range && !target.range.collapsed && target.text.trim()) document.execCommand("createLink", false, href);
  else document.execCommand("insertHTML", false, `<a href="${esc(href)}">${esc(text.trim() || url.trim())}</a>&nbsp;`);
}

/** The little form: the address, and — with nothing selected — how the link shows. */
export default function LinkPopover({ selected, onAdd, onClose, className = "" }: {
  selected: string; onAdd: (url: string, text: string) => void; onClose: () => void; className?: string;
}) {
  const [url, setUrl] = useState("https://");
  const [show, setShow] = useState<"url" | "text">("text");
  const [text, setText] = useState("");
  const box = useRef<HTMLDivElement | null>(null);
  const has = !!selected.trim();
  useEffect(() => {
    const k = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose(); };
    const t = window.setTimeout(() => document.addEventListener("mousedown", k), 0);
    return () => { window.clearTimeout(t); document.removeEventListener("mousedown", k); };
  }, [onClose]);
  const okUrl = url.trim().length > 3 && url.trim() !== "https://";
  const ready = okUrl && (has || show === "url" || !!text.trim());
  const go = () => { if (ready) onAdd(url, has || show === "url" ? "" : text); };
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); go(); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
  };
  return (
    <div ref={box} className={`lnkp ${className}`} role="dialog" aria-label="Add a link" onKeyDown={keys}>
      <div className="lnkp-h">
        <b>Add a link</b>
        <button type="button" className="lnkp-x" onClick={onClose} aria-label="Close">×</button>
      </div>
      <label className="lnkp-f"><span>Address</span>
        <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} onFocus={(e) => e.currentTarget.select()} placeholder="https://… or name@company.com" spellCheck={false} />
      </label>
      {has ? (
        <p className="lnkp-on">On the text you selected: <q>{selected.trim().slice(0, 80)}{selected.trim().length > 80 ? "…" : ""}</q></p>
      ) : (
        <>
          <div className="lnkp-seg" role="radiogroup" aria-label="How the link shows">
            <button type="button" role="radio" aria-checked={show === "text"} className={show === "text" ? "is-on" : ""} onClick={() => setShow("text")}>In a text I write</button>
            <button type="button" role="radio" aria-checked={show === "url"} className={show === "url" ? "is-on" : ""} onClick={() => setShow("url")}>The address itself</button>
          </div>
          {show === "text"
            ? <label className="lnkp-f"><span>Text that shows</span><input value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Book a call" /></label>
            : <p className="lnkp-on">It shows as <q>{url.trim() || "the address"}</q>.</p>}
          <p className="lnkp-tip">Tip: select some text first and the link goes on it.</p>
        </>
      )}
      <div className="lnkp-acts">
        <button type="button" className="lnkp-b" onClick={onClose}>Cancel</button>
        <button type="button" className="lnkp-b is-main" disabled={!ready} onClick={go}>Add link</button>
      </div>
    </div>
  );
}
