/* =====================================================================
   Marketing › post editor: the text box with LinkedIn @mentions.
   Typing "@" opens a list of what LinkedIn lets a post tag:
     · colleagues who connected LinkedIn (Settings › Integrations) — their member URN
     · CRM companies with a LinkedIn page (companies.linkedin) — the page's URN
     · a LinkedIn page link or number pasted after the "@"
   The text keeps "@Name"; the post keeps [{ name, urn }] (marketing_posts.mentions, SQL 146) and
   marketing-hub turns each "@Name" into a real LinkedIn mention when the post goes out.
   LinkedIn only links a mention whose name matches the page / person exactly.
   ===================================================================== */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { supabase } from "../../api/supabase";
import { linkedinPage, linkedinPeople, type LiPerson, type PostMention } from "../../api/marketingHub";

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where the caret is inside a textarea, in px from its top-left (a mirror div with the same text up to the caret). */
function caretXY(ta: HTMLTextAreaElement, pos: number): { x: number; y: number; h: number } {
  const cs = getComputedStyle(ta);
  const m = document.createElement("div");
  for (const k of ["boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight", "textTransform", "wordSpacing", "tabSize"] as const) {
    (m.style as any)[k] = (cs as any)[k];
  }
  Object.assign(m.style, { position: "absolute", visibility: "hidden", top: "0", left: "-9999px", whiteSpace: "pre-wrap", overflowWrap: "break-word", wordBreak: "break-word", height: "auto" });
  m.textContent = ta.value.slice(0, pos);
  const mark = document.createElement("span"); mark.textContent = "​"; m.appendChild(mark);
  document.body.appendChild(m);
  const out = { x: mark.offsetLeft, y: mark.offsetTop - ta.scrollTop, h: parseFloat(cs.lineHeight) || 22 };
  m.remove();
  return out;
}

type Co = { id: string; name: string; linkedin: string };
type Item = { k: string; kind: "person" | "org" | "paste"; name: string; sub: string; picture?: string | null; urn?: string; ref?: string };

export function MentionArea({ value, onChange, mentions, onMentions, enabled, allText, placeholder, className }: {
  value: string; onChange: (v: string) => void; mentions: PostMention[]; onMentions: (m: PostMention[]) => void;
  /** LinkedIn is one of the post's networks (and this tab's text goes to it) */
  enabled: boolean; allText: string; placeholder?: string; className?: string;
}) {
  const ta = useRef<HTMLTextAreaElement | null>(null);
  const valRef = useRef(value); valRef.current = value;
  const menRef = useRef(mentions); menRef.current = mentions;
  const [q, setQ] = useState<{ text: string; start: number; x: number; y: number } | null>(null);
  const [people, setPeople] = useState<LiPerson[]>([]);
  const [cos, setCos] = useState<Co[]>([]);
  const [hi, setHi] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ urn: string; name: string } | null>(null);
  /** the pointer only picks a row when it really moves (the list opens under a still mouse) */
  const lastPt = useRef("");

  useEffect(() => { if (enabled) void linkedinPeople().then(setPeople); }, [enabled]);

  /** "@" + what follows it, up to the caret */
  const scan = () => {
    const el = ta.current; if (!el || !enabled) { setQ(null); return; }
    const pos = el.selectionStart ?? 0;
    if (pos !== el.selectionEnd) { setQ(null); return; }
    const before = el.value.slice(0, pos);
    const m = before.match(/(?:^|[\s(¡¿"'«])@([^@#\n]{0,60})$/);
    if (!m || /\s\S*\s\S*\s/.test(m[1]) || /^\s/.test(m[1])) { setQ(null); return; }
    const start = pos - m[1].length - 1;
    const c = caretXY(el, start);
    setQ((old) => (old && old.start === start && old.text === m[1] ? old : { text: m[1], start, x: c.x, y: c.y + c.h }));
  };

  // CRM companies with a LinkedIn page, by name
  useEffect(() => {
    if (!q) return;
    const t = q.text.trim();
    if (t.length < 2 || /linkedin\.com|^\d{4,}$/.test(t)) { setCos([]); return; }
    const h = window.setTimeout(async () => {
      const { data } = await supabase.from("companies").select("id, name, linkedin").ilike("name", `%${t.replace(/[%_]/g, "")}%`)
        .not("linkedin", "is", null).neq("linkedin", "").order("name").limit(7);
      setCos(((data ?? []) as Co[]).filter((c) => /linkedin\.com\/(company|school|showcase)\//i.test(c.linkedin)));
    }, 180);
    return () => window.clearTimeout(h);
  }, [q?.text]); // eslint-disable-line react-hooks/exhaustive-deps

  const items: Item[] = useMemo(() => {
    if (!q) return [];
    const t = fold(q.text.trim());
    const out: Item[] = [];
    const pasted = q.text.trim().match(/linkedin\.com\/(?:company|school|showcase)\/[^\s/?#]+|^\d{4,}$/i)?.[0];
    if (pasted) out.push({ k: "paste", kind: "paste", name: "Tag this LinkedIn page", sub: pasted, ref: pasted });
    people.filter((p) => !t || fold(p.name).includes(t)).slice(0, 4)
      .forEach((p) => out.push({ k: p.urn, kind: "person", name: p.name, sub: p.me ? "You · LinkedIn" : "Colleague · LinkedIn", picture: p.picture, urn: p.urn }));
    cos.forEach((c) => out.push({ k: c.id, kind: "org", name: c.name, sub: c.linkedin.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""), ref: c.linkedin }));
    return out.slice(0, 9);
  }, [q, people, cos]);
  useEffect(() => { setHi(0); setErr(null); lastPt.current = ""; }, [q?.text]);

  /** "@query" (from `start`, `len` characters after the "@") → "@Name " — on the text as it is now */
  const insert = (name: string, start: number, len: number, mention: PostMention) => {
    const el = ta.current; if (!el) return;
    const cur = valRef.current;
    if (cur[start] !== "@") return;
    const end = start + 1 + len;
    const next = `${cur.slice(0, start)}@${name}${cur[end] === " " ? "" : " "}${cur.slice(end)}`;
    onChange(next);
    onMentions([...menRef.current.filter((m) => m.urn !== mention.urn), mention]);
    setQ(null);
    const caret = start + name.length + 2;
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(caret, caret); });
  };
  const pick = async (it: Item) => {
    if (!q || busy) return;
    if (it.kind === "person") { insert(it.name, q.start, q.text.length, { name: it.name, urn: it.urn!, kind: "person", picture: it.picture ?? null }); return; }
    const start = q.start, len = q.text.length;
    setBusy(it.k); setErr(null);
    const r = await linkedinPage(it.ref!);
    setBusy(null);
    if ("error" in r) { setErr(r.error); return; }
    const name = (r.name || (it.kind === "org" ? it.name : "")).trim() || "Company";
    insert(name, start, len, { name, urn: r.urn, kind: "org", ref: it.ref ?? null, check: !r.checked || !r.name });
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!q || !items.length) { if (q && e.key === "Escape") { e.preventDefault(); setQ(null); } return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => (h + 1) % items.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => (h - 1 + items.length) % items.length); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); void pick(items[hi]); }
    else if (e.key === "Escape") { e.preventDefault(); setQ(null); }
  };

  /** rename a tagged page: in the list and in the text */
  const rename = (urn: string, name: string) => {
    const m = mentions.find((x) => x.urn === urn); const nn = name.trim();
    setEdit(null);
    if (!m || !nn || nn === m.name) return;
    onChange(value.replace(new RegExp(`@${escRe(m.name)}(?![\\p{L}\\p{N}])`, "gu"), `@${nn}`));
    onMentions(mentions.map((x) => (x.urn === urn ? { ...x, name: nn, check: false } : x)));
  };

  // the list sits under the "@", inside the box
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [popX, setPopX] = useState(0);
  useLayoutEffect(() => {
    if (!q || !boxRef.current) return;
    const w = boxRef.current.clientWidth;
    setPopX(Math.max(8, Math.min(q.x, w - 336)));
  }, [q]);

  return (
    <div className={`pmn ${className ?? ""}`}>
      <div className="pmn-box" ref={boxRef}>
        <textarea ref={ta} className="pe-area" value={value} placeholder={placeholder}
          onChange={(e) => { onChange(e.target.value); requestAnimationFrame(scan); }}
          onKeyDown={onKey} onKeyUp={(e) => { if (!["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) scan(); }}
          onClick={scan} onScroll={() => setQ(null)} onBlur={() => window.setTimeout(() => { if (document.activeElement !== ta.current) setQ(null); }, 160)} />
        {q && (
          <div className="pmn-pop" style={{ left: popX, top: Math.min(q.y + 4, (boxRef.current?.clientHeight ?? 400) - 60) }} onMouseDown={(e) => e.preventDefault()} role="listbox" aria-label="Tag on LinkedIn">
            <div className="pmn-pop-h"><b>Tag on LinkedIn</b><em>{q.text.trim() ? `“${q.text.trim()}”` : "Type a name"}</em></div>
            {items.map((it, i) => (
              <button key={it.k} role="option" aria-selected={i === hi} className={`pmn-it ${i === hi ? "is-hi" : ""}`} onMouseMove={(e) => { const pt = `${e.clientX},${e.clientY}`; if (lastPt.current && lastPt.current !== pt && hi !== i) setHi(i); lastPt.current = pt; }} onClick={() => void pick(it)} disabled={!!busy}>
                <span className={`pmn-av is-${it.kind}`}>{it.picture ? <img src={it.picture} alt="" /> : it.kind === "person" ? initials(it.name) : <CoIco />}</span>
                <span className="pmn-it-t"><b>{it.name}</b><em>{it.sub}</em></span>
                {busy === it.k && <i className="mkh-spin" />}
              </button>
            ))}
            {!items.length && (
              <p className="pmn-none">{q.text.trim().length < 2 ? "Colleagues with LinkedIn connected, or a company with a LinkedIn page." : "No colleague or company with a LinkedIn page by that name. Paste the page's link after the @."}</p>
            )}
            {err && <p className="pmn-err">{err}</p>}
            <p className="pmn-foot">LinkedIn lets a post tag company pages and colleagues who connected LinkedIn here.</p>
          </div>
        )}
      </div>
      {mentions.length > 0 && (
        <div className="pmn-chips">
          <span className="pmn-chips-k">Tagged on LinkedIn</span>
          {mentions.map((m) => {
            const there = allText.includes(`@${m.name}`);
            return (
              <span key={m.urn} className={`pmn-chip ${there ? "" : "is-off"} ${m.check ? "is-check" : ""}`} title={!there ? "Not in the text any more — it won't be tagged" : m.check ? "LinkedIn only tags it when the name is exactly the page's name — click to check it" : m.urn}>
                <span className={`pmn-av is-${m.kind}`}>{m.picture ? <img src={m.picture} alt="" /> : m.kind === "person" ? initials(m.name) : <CoIco />}</span>
                {edit?.urn === m.urn ? (
                  <input autoFocus value={edit.name} onChange={(e) => setEdit({ urn: m.urn, name: e.target.value })} onBlur={() => rename(m.urn, edit.name)}
                    onKeyDown={(e) => { if (e.key === "Enter") rename(m.urn, edit.name); if (e.key === "Escape") setEdit(null); }} aria-label="Exact page name" />
                ) : (
                  <button className="pmn-chip-n" onClick={() => m.kind === "org" && setEdit({ urn: m.urn, name: m.name })} disabled={m.kind !== "org"}>{m.name}</button>
                )}
                {m.check && there && edit?.urn !== m.urn && <em>Check the exact page name</em>}
                <button className="pmn-chip-x" onClick={() => onMentions(mentions.filter((x) => x.urn !== m.urn))} aria-label={`Don't tag ${m.name}`}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CoIco() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16" /><path d="M15 10h4a1 1 0 0 1 1 1v10" /><path d="M8 8h3M8 12h3M8 16h3M3 21h18" /></svg>;
}

/** A post's text as LinkedIn shows it: tagged names (without the "@") and #hashtags in blue. */
export function PostRich({ text, mentions }: { text: string; mentions?: PostMention[] }): ReactNode {
  const names = (mentions ?? []).map((m) => m.name).filter(Boolean).sort((a, b) => b.length - a.length);
  const re = new RegExp(`${names.length ? `@(${names.map(escRe).join("|")})|` : ""}(^|[\\s(])(#[\\p{L}\\p{N}_]+)`, "gu");
  const out: ReactNode[] = [];
  let last = 0, n = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (names.length && m[1]) {
      out.push(text.slice(last, at)); out.push(<b key={n++} className="pmn-at">{m[1]}</b>); last = at + m[0].length;
    } else {
      const lead = m[names.length ? 2 : 1] ?? "", tag = m[names.length ? 3 : 2] ?? "";
      out.push(text.slice(last, at) + lead); out.push(<span key={n++} className="pmn-tag">{tag}</span>); last = at + m[0].length;
    }
  }
  out.push(text.slice(last));
  return <>{out}</>;
}
