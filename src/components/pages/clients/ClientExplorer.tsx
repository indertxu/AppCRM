/* eslint-disable @typescript-eslint/no-explicit-any */
/* =====================================================================
   A client's directory as a real file explorer (Clients › Folders):
   folders in a tree on the left, the open folder as cards or a list,
   pick several (click · ⌘/Ctrl · Shift · drag a box), drag them onto a
   folder (or the tree, or the path), cut / copy / paste, rename, notes,
   right-click menus everywhere, back / forward / up, search the whole
   directory, drop files from the computer to upload.
   Same tables and bucket as before (client_folders, client_files,
   storage "client-files").
   ===================================================================== */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../api/supabase";
import { ApplyTemplateMenu } from "./ClientDirectory";
import FileLogo, { fileLogoKey } from "../../framework/FileLogo";
import "./ClientExplorer.css";

interface Folder { id: string; parent_id: string | null; name: string; sort: number; created_at?: string | null }
interface CFile {
  id: string; folder_id: string | null; storage_path: string;
  name: string; note: string | null; mime: string | null; size_bytes: number | null; created_at: string;
}
type Key = string;                         // "d:<folder id>" or "f:<file id>"
const dk = (id: string) => `d:${id}`;
const fk = (id: string) => `f:${id}`;
const isD = (k: Key) => k.startsWith("d:");
const idOf = (k: Key) => k.slice(2);
type View = "grid" | "list";
type SortK = "name" | "kind" | "size" | "date";
type Clip = { mode: "cut" | "copy"; keys: Key[] } | null;
type MenuItem = { label: string; icon?: string; keys?: string; danger?: boolean; disabled?: boolean; run?: () => void } | "sep";

const BUCKET = "client-files";
const PREF_VIEW = "xpl.view", PREF_SORT = "xpl.sort", PREF_TREE = "xpl.tree";
const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = MAC ? "⌘" : "Ctrl+";

const prettySize = (b: number | null | undefined) => {
  if (!b) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 ** 3) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
};
const extOf = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");
const kindOf = (name: string, mime: string | null): { label: string; tone: string; word: string } => {
  const e = extOf(name);
  if (e === "pdf" || mime === "application/pdf") return { label: "PDF", tone: "red", word: "PDF document" };
  if (["doc", "docx", "rtf", "odt"].includes(e)) return { label: "DOC", tone: "blue", word: "Word document" };
  if (["xls", "xlsx", "csv", "ods"].includes(e)) return { label: e === "csv" ? "CSV" : "XLS", tone: "green", word: e === "csv" ? "CSV table" : "Spreadsheet" };
  if (["ppt", "pptx", "key", "odp"].includes(e)) return { label: "PPT", tone: "orange", word: "Presentation" };
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "bmp"].includes(e) || (mime ?? "").startsWith("image/")) return { label: e.toUpperCase().slice(0, 4) || "IMG", tone: "violet", word: "Image" };
  if (["zip", "rar", "7z", "gz", "tar"].includes(e)) return { label: "ZIP", tone: "grey", word: "Archive" };
  if (["txt", "md", "json", "xml"].includes(e)) return { label: e.toUpperCase(), tone: "grey", word: "Text" };
  if (["mp4", "mov", "avi", "webm"].includes(e) || (mime ?? "").startsWith("video/")) return { label: "VID", tone: "pink", word: "Video" };
  if (["eml", "msg"].includes(e)) return { label: "MAIL", tone: "sky", word: "E-mail" };
  return { label: e ? e.slice(0, 4).toUpperCase() : "FILE", tone: "grey", word: e ? `${e.toUpperCase()} file` : "File" };
};
const isImage = (f: CFile) => kindOf(f.name, f.mime).word === "Image" && extOf(f.name) !== "heic";
const fmtDate = (iso?: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso), now = new Date();
  if (d.toDateString() === now.toDateString()) return `Today, ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
};
const readPref = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } };
const writePref = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const safeName = (n: string) => n.replace(/[^\w.\-]+/g, "_");

/* ---------- icons ---------- */
const P: Record<string, string> = {
  back: "M15 18l-6-6 6-6", fwd: "M9 18l6-6-6-6", up: "M12 19V5M5 12l7-7 7 7",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z", list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3", x: "M18 6 6 18M6 6l12 12",
  plusf: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2zM12 11v6M9 14h6",
  upload: "M12 16V4M8 8l4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2", download: "M12 4v12M7 11l5 5 5-5M4 20h16",
  open: "M14 3h7v7M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5",
  rename: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z", note: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  cut: "M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12",
  copy: "M9 9h11v11H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1",
  paste: "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 2h6v4H9z",
  dup: "M8 8h12v12H8zM4 16V4h12", trash: "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14",
  all: "M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11", sort: "M3 6h18M6 12h12M10 18h4",
  home: "M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", chev: "M9 18l6-6-6-6", into: "M5 12h14M13 6l6 6-6 6",
  templates: "M12 3 2 8l10 5 10-5zM2 13l10 5 10-5M2 17.5l10 5 10-5",
  folder: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z",
};
const Ic = ({ d, s = 16 }: { d: string; s?: number }) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={P[d] ?? d} /></svg>
);
/** A folder: two tones, the front lifts a little when it opens (hover / drop). */
const FolderArt = ({ open = false, size = 56, count }: { open?: boolean; size?: number; count?: number }) => (
  <span className={`xpl-fart ${open ? "is-open" : ""}`} style={{ width: size, height: size * 0.82 } as CSSProperties}>
    <svg viewBox="0 0 64 52" aria-hidden="true">
      <path className="xpl-fart-back" d="M4 8a5 5 0 0 1 5-5h14.5a5 5 0 0 1 3.6 1.5l3.8 3.9a5 5 0 0 0 3.6 1.5H55a5 5 0 0 1 5 5V44a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z" />
      <rect className="xpl-fart-paper" x="10" y="12" width="44" height="22" rx="3" />
      <path className="xpl-fart-front" d="M2.6 20.6A5 5 0 0 1 7.5 17h49a5 5 0 0 1 4.9 6l-4 21A5 5 0 0 1 52.5 48h-41a5 5 0 0 1-4.9-4z" />
    </svg>
    {count != null && count > 0 && <em>{count}</em>}
  </span>
);
const FileArt = ({ f, thumb, size = 56 }: { f: CFile; thumb?: string; size?: number }) => {
  const k = kindOf(f.name, f.mime);
  if (thumb) return <span className="xpl-thumb" style={{ width: size * 1.3, height: size } as CSSProperties}><img src={thumb} alt="" draggable={false} loading="lazy" /></span>;
  // the real app logo (Excel, Word, PowerPoint, PDF, Outlook…) when the type has one
  if (fileLogoKey(f.name, f.mime)) return <span className="xpl-logo" style={{ width: size, height: size } as CSSProperties}><FileLogo name={f.name} mime={f.mime} size={size} /></span>;
  return (
    <span className={`xpl-doc is-${k.tone}`} style={{ width: size * 0.78, height: size } as CSSProperties}>
      <svg viewBox="0 0 44 56" aria-hidden="true">
        <path className="xpl-doc-page" d="M6 2h22l14 14v34a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4z" />
        <path className="xpl-doc-fold" d="M28 2v10a4 4 0 0 0 4 4h10z" />
      </svg>
      <b>{k.label}</b>
    </span>
  );
};

/* ---------- the context menu ---------- */
function Menu({ at, items, onClose }: { at: { x: number; y: number }; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8)), y: Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8)) });
  }, [at]);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    const scroll = () => onClose();
    document.addEventListener("mousedown", down, true); document.addEventListener("keydown", key, true); window.addEventListener("resize", scroll);
    return () => { document.removeEventListener("mousedown", down, true); document.removeEventListener("keydown", key, true); window.removeEventListener("resize", scroll); };
  }, [onClose]);
  return createPortal(
    <div className="xpl-menu" ref={ref} style={{ left: pos.x, top: pos.y }} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) => it === "sep" ? <span key={i} className="xpl-menu-sep" /> : (
        <button key={i} type="button" role="menuitem" className={it.danger ? "is-danger" : ""} disabled={it.disabled}
          onClick={() => { onClose(); it.run?.(); }}>
          <span className="xpl-menu-ico">{it.icon ? <Ic d={it.icon} s={15} /> : null}</span>
          <span className="xpl-menu-l">{it.label}</span>
          {it.keys && <kbd>{it.keys}</kbd>}
        </button>
      ))}
    </div>,
    document.body,
  );
}

export default function ClientExplorer({ clientId, tenantId: tenantIn, title, hint, extra }: {
  clientId: string; tenantId: string | null;
  /** Shown at the start of the bar (the page's name), so the page needs no header of its own. */
  title?: string; hint?: string;
  /** More buttons for the bar, before Templates. */
  extra?: ReactNode;
}) {
  // the tenant (for storage paths and inserts): given, or read from the client
  const [tenantId, setTenantId] = useState<string | null>(tenantIn);
  useEffect(() => {
    if (tenantIn) { setTenantId(tenantIn); return; }
    let live = true;
    void supabase.from("clients").select("tenant_id").eq("id", clientId).maybeSingle().then(({ data }) => { if (live) setTenantId((data as any)?.tenant_id ?? null); });
    return () => { live = false; };
  }, [tenantIn, clientId]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [files, setFiles] = useState<CFile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [cwd, setCwdRaw] = useState<string | null>(null);
  const [hist, setHist] = useState<{ back: (string | null)[]; fwd: (string | null)[] }>({ back: [], fwd: [] });
  const [view, setViewRaw] = useState<View>(() => readPref<View>(PREF_VIEW, "grid"));
  const [sort, setSortRaw] = useState<{ k: SortK; asc: boolean }>(() => readPref(PREF_SORT, { k: "name" as SortK, asc: true }));
  const [sel, setSel] = useState<Set<Key>>(() => new Set());
  const anchor = useRef<Key | null>(null);
  const [renaming, setRenaming] = useState<Key | null>(null);
  const [clip, setClip] = useState<Clip>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [ask, setAsk] = useState<Key[] | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [drag, setDrag] = useState<Key[] | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);   // "d:<id>", "root", "tree:<id>", "crumb:<id|root>"
  const [osOver, setOsOver] = useState(false);
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [busy, setBusy] = useState<{ n: number; done: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [openTree, setOpenTree] = useState<Set<string>>(() => new Set(readPref<string[]>(PREF_TREE, [])));
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadTo = useRef<string | null>(null);

  const setView = (v: View) => { setViewRaw(v); writePref(PREF_VIEW, v); };
  const setSort = (k: SortK) => setSortRaw((s) => { const n = { k, asc: s.k === k ? !s.asc : true }; writePref(PREF_SORT, n); return n; });
  const flash = useCallback((m: string) => { setToast(m); window.setTimeout(() => setToast((t) => (t === m ? null : t)), 3200); }, []);

  /* ---------- load ---------- */
  useEffect(() => {
    let alive = true;
    (async () => {
      const [{ data: fd, error: e1 }, { data: fl, error: e2 }] = await Promise.all([
        supabase.from("client_folders").select("*").eq("client_id", clientId).order("sort").order("name"),
        supabase.from("client_files").select("*").eq("client_id", clientId).order("created_at", { ascending: false }),
      ]);
      if (!alive) return;
      if (e1 || e2) setErr((e1 ?? e2)!.message);
      setFolders((fd ?? []) as Folder[]); setFiles((fl ?? []) as CFile[]); setLoaded(true);
    })();
    return () => { alive = false; };
  }, [clientId]);

  /* ---------- the shape of the directory ---------- */
  const byId = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const kids = useMemo(() => {
    const m = new Map<string | null, Folder[]>();
    folders.forEach((f) => { const k = f.parent_id ?? null; (m.get(k) ?? m.set(k, []).get(k)!).push(f); });
    m.forEach((xs) => xs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })));
    return m;
  }, [folders]);
  const filesIn = useMemo(() => {
    const m = new Map<string | null, CFile[]>();
    files.forEach((f) => { const k = f.folder_id ?? null; (m.get(k) ?? m.set(k, []).get(k)!).push(f); });
    return m;
  }, [files]);
  const pathOf = useCallback((id: string | null): Folder[] => {
    const out: Folder[] = []; let cur = id; let guard = 0;
    while (cur && guard++ < 64) { const f = byId.get(cur); if (!f) break; out.unshift(f); cur = f.parent_id; }
    return out;
  }, [byId]);
  /** Folder ids inside a folder (all levels) — and the folder itself. */
  const subtree = useCallback((id: string): Set<string> => {
    const s = new Set([id]); const walk = (p: string) => (kids.get(p) ?? []).forEach((c) => { s.add(c.id); walk(c.id); }); walk(id); return s;
  }, [kids]);
  const countIn = useCallback((id: string) => (kids.get(id)?.length ?? 0) + (filesIn.get(id)?.length ?? 0), [kids, filesIn]);
  const deepSize = useCallback((id: string) => { const s = subtree(id); return files.filter((f) => f.folder_id && s.has(f.folder_id)).reduce((t, f) => t + (f.size_bytes ?? 0), 0); }, [subtree, files]);
  // the open folder vanished (deleted / moved elsewhere by someone): back to the top
  useEffect(() => { if (loaded && cwd && !byId.has(cwd)) setCwdRaw(null); }, [loaded, cwd, byId]);

  /* ---------- what's shown ---------- */
  type Row = { key: Key; kind: "folder"; f: Folder } | { key: Key; kind: "file"; f: CFile };
  const searching = q.trim().length > 0;
  const rows: Row[] = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const fo = searching ? folders.filter((f) => f.name.toLowerCase().includes(ql)) : kids.get(cwd) ?? [];
    const fi = searching ? files.filter((f) => f.name.toLowerCase().includes(ql) || (f.note ?? "").toLowerCase().includes(ql)) : filesIn.get(cwd) ?? [];
    const dir = sort.asc ? 1 : -1;
    const cmpName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
    const fs = [...fo].sort((a, b) => (sort.k === "date" ? String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) : sort.k === "size" ? countIn(a.id) - countIn(b.id) : cmpName(a.name, b.name)) * dir || cmpName(a.name, b.name));
    const ff = [...fi].sort((a, b) => (sort.k === "date" ? a.created_at.localeCompare(b.created_at) : sort.k === "size" ? (a.size_bytes ?? 0) - (b.size_bytes ?? 0)
      : sort.k === "kind" ? kindOf(a.name, a.mime).word.localeCompare(kindOf(b.name, b.mime).word) : cmpName(a.name, b.name)) * dir || cmpName(a.name, b.name));
    return [...fs.map((f) => ({ key: dk(f.id), kind: "folder" as const, f })), ...ff.map((f) => ({ key: fk(f.id), kind: "file" as const, f }))];
  }, [q, searching, folders, files, kids, filesIn, cwd, sort, countIn]);
  const rowKeys = useMemo(() => rows.map((r) => r.key), [rows]);
  // picks that are no longer shown go away
  useEffect(() => { setSel((s) => { const n = new Set([...s].filter((k) => rowKeys.includes(k))); return n.size === s.size ? s : n; }); }, [rowKeys]);

  /* ---------- image previews ---------- */
  useEffect(() => {
    const need = rows.filter((r) => r.kind === "file" && isImage(r.f as CFile) && !thumbs[(r.f as CFile).id]).map((r) => r.f as CFile).slice(0, 60);
    if (!need.length) return;
    let off = false;
    supabase.storage.from(BUCKET).createSignedUrls(need.map((f) => f.storage_path), 3600).then(({ data }) => {
      if (off || !data) return;
      const m: Record<string, string> = {};
      data.forEach((d: any, i: number) => { if (d?.signedUrl) m[need[i].id] = d.signedUrl; });
      setThumbs((t) => ({ ...t, ...m }));
    }).catch(() => {});
    return () => { off = true; };
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- moving around ---------- */
  const go = (id: string | null, push = true) => {
    if (id === cwd && !searching) return;
    if (push) setHist((h) => ({ back: [...h.back, cwd].slice(-50), fwd: [] }));
    setCwdRaw(id); setSel(new Set()); anchor.current = null; setRenaming(null); setQ("");
    if (id) setOpenTree((t) => { const n = new Set(t); pathOf(id).forEach((f) => n.add(f.id)); return n; });
    rootRef.current?.focus({ preventScroll: true });
  };
  const back = () => setHist((h) => { if (!h.back.length) return h; const to = h.back[h.back.length - 1]; setCwdRaw(to); setSel(new Set()); return { back: h.back.slice(0, -1), fwd: [cwd, ...h.fwd] }; });
  const fwd = () => setHist((h) => { if (!h.fwd.length) return h; const to = h.fwd[0]; setCwdRaw(to); setSel(new Set()); return { back: [...h.back, cwd], fwd: h.fwd.slice(1) }; });
  const up = () => { if (cwd) go(byId.get(cwd)?.parent_id ?? null); };
  const toggleTree = (id: string) => setOpenTree((t) => { const n = new Set(t); if (n.has(id)) n.delete(id); else n.add(id); writePref(PREF_TREE, [...n]); return n; });

  /* ---------- the work ---------- */
  const uniqueName = (parent: string | null, base: string, skip?: string) => {
    const taken = new Set((kids.get(parent) ?? []).filter((f) => f.id !== skip).map((f) => f.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; i < 999; i++) { const n = `${base} ${i}`; if (!taken.has(n.toLowerCase())) return n; }
    return `${base} ${Date.now()}`;
  };
  const newFolder = async (parent: string | null = cwd) => {
    const name = uniqueName(parent, "New folder");
    const { data, error } = await supabase.from("client_folders").insert({ client_id: clientId, parent_id: parent, name, sort: (kids.get(parent)?.length ?? 0) }).select().single();
    if (error || !data) { setErr(error?.message ?? "The folder couldn't be made."); return; }
    setFolders((xs) => [...xs, data as Folder]);
    if (parent !== cwd) go(parent);
    window.setTimeout(() => { setSel(new Set([dk((data as Folder).id)])); setRenaming(dk((data as Folder).id)); }, 0);
  };
  const rename = async (key: Key, raw: string) => {
    setRenaming(null);
    const name = raw.replace(/\s+/g, " ").trim();
    if (!name) return;
    if (isD(key)) {
      const f = byId.get(idOf(key)); if (!f || f.name === name) return;
      setFolders((xs) => xs.map((x) => (x.id === f.id ? { ...x, name } : x)));
      const { error } = await supabase.from("client_folders").update({ name }).eq("id", f.id);
      if (error) setErr(error.message);
    } else {
      const f = files.find((x) => x.id === idOf(key)); if (!f || f.name === name) return;
      setFiles((xs) => xs.map((x) => (x.id === f.id ? { ...x, name } : x)));
      const { error } = await supabase.from("client_files").update({ name }).eq("id", f.id);
      if (error) setErr(error.message);
    }
    rootRef.current?.focus({ preventScroll: true });
  };
  /** Only the outermost of what's picked (a folder takes everything inside it along). */
  const outer = (keys: Key[]): Key[] => {
    const dIds = keys.filter(isD).map(idOf);
    const inside = (folderId: string | null) => { let c = folderId; let g = 0; while (c && g++ < 64) { if (dIds.includes(c)) return true; c = byId.get(c)?.parent_id ?? null; } return false; };
    return keys.filter((k) => (isD(k) ? !inside(byId.get(idOf(k))?.parent_id ?? null) : !inside(files.find((f) => f.id === idOf(k))?.folder_id ?? null)));
  };
  /** Can these go into that folder (not into themselves or their own insides)? */
  const canInto = (keys: Key[], target: string | null) => !keys.some((k) => isD(k) && target !== null && subtree(idOf(k)).has(target));
  const moveTo = async (keys: Key[], target: string | null) => {
    const ks = outer(keys);
    if (!canInto(ks, target)) { flash("A folder can't go inside itself"); return; }
    const dIds = ks.filter(isD).map(idOf).filter((id) => (byId.get(id)?.parent_id ?? null) !== target);
    const fIds = ks.filter((k) => !isD(k)).map(idOf).filter((id) => (files.find((f) => f.id === id)?.folder_id ?? null) !== target);
    if (!dIds.length && !fIds.length) return;
    setFolders((xs) => xs.map((f) => (dIds.includes(f.id) ? { ...f, parent_id: target } : f)));
    setFiles((xs) => xs.map((f) => (fIds.includes(f.id) ? { ...f, folder_id: target } : f)));
    const [a, b] = await Promise.all([
      dIds.length ? supabase.from("client_folders").update({ parent_id: target }).in("id", dIds) : Promise.resolve({ error: null }),
      fIds.length ? supabase.from("client_files").update({ folder_id: target }).in("id", fIds) : Promise.resolve({ error: null }),
    ]);
    const e = (a as any).error ?? (b as any).error;
    if (e) { setErr(e.message); return; }
    const n = dIds.length + fIds.length;
    flash(`${n} item${n === 1 ? "" : "s"} moved to ${target ? `“${byId.get(target)?.name}”` : "the top"}`);
  };
  const copyFile = async (f: CFile, target: string | null, rename = false): Promise<CFile | null> => {
    if (!tenantId) return null;
    const name = rename ? f.name.replace(/(\.[^.]+)?$/, (m) => ` copy${m}`) : f.name;
    const path = `${tenantId}/${clientId}/${crypto.randomUUID()}_${safeName(name)}`;
    const cp = await supabase.storage.from(BUCKET).copy(f.storage_path, path);
    if (cp.error) { setErr(`${f.name}: ${cp.error.message}`); return null; }
    const { data, error } = await supabase.from("client_files").insert({ client_id: clientId, folder_id: target, storage_path: path, name, mime: f.mime, size_bytes: f.size_bytes, note: f.note }).select().single();
    if (error || !data) { setErr(`${f.name}: ${error?.message}`); await supabase.storage.from(BUCKET).remove([path]); return null; }
    return data as CFile;
  };
  const copyTo = async (keys: Key[], target: string | null) => {
    const ks = outer(keys);
    if (!canInto(ks, target)) { flash("A folder can't be copied inside itself"); return; }
    const total = ks.reduce((t, k) => t + (isD(k) ? files.filter((f) => f.folder_id && subtree(idOf(k)).has(f.folder_id)).length + 1 : 1), 0);
    setBusy({ n: total, done: 0 });
    const newF: Folder[] = [], newFi: CFile[] = [];
    const tick = () => setBusy((b) => (b ? { ...b, done: b.done + 1 } : b));
    const copyFolder = async (src: Folder, parent: string | null, name: string) => {
      const { data, error } = await supabase.from("client_folders").insert({ client_id: clientId, parent_id: parent, name, sort: src.sort }).select().single();
      tick();
      if (error || !data) { setErr(error?.message ?? "Copy stopped."); return; }
      newF.push(data as Folder);
      for (const f of filesIn.get(src.id) ?? []) { const c = await copyFile(f, (data as Folder).id); tick(); if (c) newFi.push(c); }
      for (const c of kids.get(src.id) ?? []) await copyFolder(c, (data as Folder).id, c.name);
    };
    for (const k of ks) {
      if (isD(k)) {
        const src = byId.get(idOf(k)); if (!src) continue;
        const same = (src.parent_id ?? null) === target;
        await copyFolder(src, target, same ? uniqueName(target, `${src.name} copy`) : uniqueName(target, src.name));
      } else {
        const src = files.find((f) => f.id === idOf(k)); if (!src) continue;
        const c = await copyFile(src, target, (src.folder_id ?? null) === target); tick(); if (c) newFi.push(c);
      }
    }
    setFolders((xs) => [...xs, ...newF]); setFiles((xs) => [...newFi, ...xs]);
    setBusy(null);
    flash(`${ks.length} item${ks.length === 1 ? "" : "s"} copied to ${target ? `“${byId.get(target)?.name}”` : "the top"}`);
  };
  const paste = async (target: string | null = cwd) => {
    if (!clip) return;
    if (clip.mode === "cut") { await moveTo(clip.keys, target); setClip(null); }
    else await copyTo(clip.keys, target);
  };
  const remove = async (keys: Key[]) => {
    setAsk(null);
    const ks = outer(keys);
    const dIds = ks.filter(isD).map(idOf);
    const all = new Set<string>(); dIds.forEach((id) => subtree(id).forEach((x) => all.add(x)));
    const fIds = new Set(ks.filter((k) => !isD(k)).map(idOf));
    const goneFiles = files.filter((f) => fIds.has(f.id) || (f.folder_id && all.has(f.folder_id)));
    setFolders((xs) => xs.filter((f) => !all.has(f.id)));
    setFiles((xs) => xs.filter((f) => !goneFiles.some((g) => g.id === f.id)));
    setSel(new Set());
    if (cwd && all.has(cwd)) setCwdRaw(null);
    const paths = goneFiles.map((f) => f.storage_path);
    for (let i = 0; i < paths.length; i += 100) await supabase.storage.from(BUCKET).remove(paths.slice(i, i + 100));
    if (fIds.size) await supabase.from("client_files").delete().in("id", [...fIds]);
    if (dIds.length) { const { error } = await supabase.from("client_folders").delete().in("id", dIds); if (error) setErr(error.message); }
    flash(`${ks.length} item${ks.length === 1 ? "" : "s"} deleted`);
  };
  const upload = async (list: FileList | File[], target: string | null = cwd) => {
    const arr = Array.from(list).filter((f) => f.size > 0 || f.type);
    if (!arr.length) return;
    if (!tenantId) { setErr("Still loading — try again in a moment."); return; }
    setErr(null); setBusy({ n: arr.length, done: 0 });
    const made: CFile[] = [];
    await Promise.all(arr.map(async (f) => {
      const path = `${tenantId}/${clientId}/${crypto.randomUUID()}_${safeName(f.name)}`;
      const upr = await supabase.storage.from(BUCKET).upload(path, f, { contentType: f.type || undefined });
      if (upr.error) { setErr(`${f.name}: ${upr.error.message}`); setBusy((b) => (b ? { ...b, done: b.done + 1 } : b)); return; }
      const { data, error } = await supabase.from("client_files").insert({ client_id: clientId, folder_id: target, storage_path: path, name: f.name, mime: f.type || null, size_bytes: f.size }).select().single();
      if (error || !data) { setErr(`${f.name}: ${error?.message}`); await supabase.storage.from(BUCKET).remove([path]); }
      else made.push(data as CFile);
      setBusy((b) => (b ? { ...b, done: b.done + 1 } : b));
    }));
    setFiles((xs) => [...made, ...xs]);
    setBusy(null);
    if (made.length) { flash(`${made.length} file${made.length === 1 ? "" : "s"} uploaded${target !== cwd ? ` to “${target ? byId.get(target)?.name : "the top"}”` : ""}`); if (target === cwd) setSel(new Set(made.map((f) => fk(f.id)))); }
    if (inputRef.current) inputRef.current.value = "";
  };
  const openFile = async (f: CFile, download = false) => {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(f.storage_path, 120, download ? { download: f.name } : undefined);
    if (error || !data) { setErr(error?.message ?? "The file couldn't be opened."); return; }
    window.open(data.signedUrl, "_blank", "noopener");
  };
  const saveNote = async (id: string, note: string) => {
    const v = note.trim() || null;
    setNoteFor(null);
    setFiles((xs) => xs.map((f) => (f.id === id ? { ...f, note: v } : f)));
    const { error } = await supabase.from("client_files").update({ note: v }).eq("id", id);
    if (error) setErr(error.message);
  };
  const openKey = (k: Key) => {
    if (isD(k)) go(idOf(k));
    else { const f = files.find((x) => x.id === idOf(k)); if (f) void openFile(f); }
  };

  /* ---------- picking ---------- */
  const pickDown = (e: React.MouseEvent, k: Key) => {
    if (e.button !== 0) return;
    rootRef.current?.focus({ preventScroll: true });
    if (e.shiftKey && anchor.current && rowKeys.includes(anchor.current)) {
      const a = rowKeys.indexOf(anchor.current), b = rowKeys.indexOf(k);
      const range = rowKeys.slice(Math.min(a, b), Math.max(a, b) + 1);
      setSel((s) => (e.metaKey || e.ctrlKey ? new Set([...s, ...range]) : new Set(range)));
      return;
    }
    if (e.metaKey || e.ctrlKey) { setSel((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; }); anchor.current = k; return; }
    if (!sel.has(k)) setSel(new Set([k]));
    anchor.current = k;
  };
  const pickClick = (e: React.MouseEvent, k: Key) => {
    if (e.shiftKey || e.metaKey || e.ctrlKey || drag) return;
    if (sel.size > 1) setSel(new Set([k]));
  };
  const picked = (k?: Key) => (k && !sel.has(k) ? [k] : [...sel]);

  /* ---------- the box (drag on the empty space) ---------- */
  const boxBase = useRef<Set<Key>>(new Set());
  const startBox = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest("[data-key], .xpl-head, .xpl-ren, button, input")) return;
    const area = areaRef.current; if (!area) return;
    rootRef.current?.focus({ preventScroll: true });
    const r = area.getBoundingClientRect();
    const x = e.clientX - r.left + area.scrollLeft, y = e.clientY - r.top + area.scrollTop;
    boxBase.current = e.shiftKey || e.metaKey || e.ctrlKey ? new Set(sel) : new Set();
    if (!boxBase.current.size) setSel(new Set());
    setBox({ x0: x, y0: y, x1: x, y1: y });
    e.preventDefault();
  };
  useEffect(() => {
    if (!box) return;
    const move = (e: MouseEvent) => {
      const area = areaRef.current; if (!area) return;
      const r = area.getBoundingClientRect();
      const x1 = e.clientX - r.left + area.scrollLeft, y1 = e.clientY - r.top + area.scrollTop;
      setBox((b) => (b ? { ...b, x1, y1 } : b));
      const L = Math.min(box.x0, x1), R = Math.max(box.x0, x1), T = Math.min(box.y0, y1), B = Math.max(box.y0, y1);
      if (R - L < 4 && B - T < 4) return;
      const hit = new Set(boxBase.current);
      area.querySelectorAll<HTMLElement>("[data-key]").forEach((el) => {
        const er = el.getBoundingClientRect();
        const ex = er.left - r.left + area.scrollLeft, ey = er.top - r.top + area.scrollTop;
        if (ex < R && ex + er.width > L && ey < B && ey + er.height > T) hit.add(el.dataset.key!);
      });
      setSel(hit);
      // scroll while the box reaches the edge
      if (e.clientY > r.bottom - 24) area.scrollTop += 14; else if (e.clientY < r.top + 24) area.scrollTop -= 14;
    };
    const upH = () => setBox(null);
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", upH);
    return () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", upH); };
  }, [box?.x0, box?.y0]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- drag & drop ---------- */
  const DT = "application/x-client-explorer";
  const dragStart = (e: React.DragEvent, k: Key) => {
    const ks = outer(picked(k));
    if (!sel.has(k)) setSel(new Set([k]));
    setDrag(ks);
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData(DT, ks.join(","));
    const g = document.createElement("div");
    g.className = "xpl-ghost";
    const first = rows.find((r) => r.key === ks[0]);
    const nm = first ? first.f.name : "Items";
    g.innerHTML = `<i class="${isD(ks[0]) ? "is-d" : ""}"></i><b></b>${ks.length > 1 ? `<em>${ks.length}</em>` : ""}`;
    (g.querySelector("b") as HTMLElement).textContent = ks.length > 1 ? `${nm} + ${ks.length - 1} more` : nm;
    document.body.appendChild(g);
    e.dataTransfer.setDragImage(g, 20, 20);
    window.setTimeout(() => g.remove(), 0);
  };
  const dragEnd = () => { setDrag(null); setDropOn(null); };
  const isOs = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files") && !Array.from(e.dataTransfer.types).includes(DT);
  /** A place things can be dropped on: a folder (id) or the top (null). */
  const dropProps = (target: string | null, tag: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (drag) { if (!canInto(drag, target)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = e.altKey ? "copy" : "move"; }
      else if (isOs(e)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "copy"; }
      else return;
      if (dropOn !== tag) setDropOn(tag);
    },
    onDragLeave: (e: React.DragEvent) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node) && dropOn === tag) setDropOn(null); },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault(); e.stopPropagation(); setDropOn(null); setOsOver(false);
      if (drag) { const ks = drag; setDrag(null); if (e.altKey) void copyTo(ks, target); else void moveTo(ks, target); }
      else if (e.dataTransfer.files?.length) void upload(e.dataTransfer.files, target);
    },
  });

  /* ---------- menus ---------- */
  const itemMenu = (k: Key, at: { x: number; y: number }) => {
    if (!sel.has(k)) { setSel(new Set([k])); anchor.current = k; }
    const ks = picked(k);
    const one = ks.length === 1 ? ks[0] : null;
    const oneFolder = one && isD(one) ? byId.get(idOf(one)) : null;
    const oneFile = one && !isD(one) ? files.find((f) => f.id === idOf(one)) : null;
    const n = ks.length;
    const items: MenuItem[] = [
      ...(oneFolder ? [{ label: "Open", icon: "into", keys: "↵", run: () => go(oneFolder.id) } as MenuItem] : []),
      ...(oneFile ? [{ label: "Open", icon: "open", keys: "↵", run: () => void openFile(oneFile) } as MenuItem, { label: "Download", icon: "download", run: () => void openFile(oneFile, true) } as MenuItem] : []),
      ...(!one && ks.every((x) => !isD(x)) ? [{ label: `Download ${n} files`, icon: "download", run: () => ks.forEach((x) => { const f = files.find((y) => y.id === idOf(x)); if (f) void openFile(f, true); }) } as MenuItem] : []),
      ...(searching && one ? [{ label: "Show where it is", icon: "into", run: () => { const parent = isD(one) ? byId.get(idOf(one))?.parent_id ?? null : files.find((f) => f.id === idOf(one))?.folder_id ?? null; go(parent); window.setTimeout(() => setSel(new Set([one])), 0); } } as MenuItem] : []),
      "sep",
      ...(one ? [{ label: "Rename", icon: "rename", keys: "F2", run: () => setRenaming(one) } as MenuItem] : []),
      ...(oneFile ? [{ label: oneFile.note ? "Edit note" : "Add a note", icon: "note", run: () => setNoteFor(oneFile.id) } as MenuItem] : []),
      ...(oneFolder ? [{ label: "New folder inside", icon: "plusf", run: () => void newFolder(oneFolder.id) } as MenuItem, { label: "Upload files here", icon: "upload", run: () => { uploadTo.current = oneFolder.id; inputRef.current?.click(); } } as MenuItem] : []),
      "sep",
      { label: n > 1 ? `Cut ${n} items` : "Cut", icon: "cut", keys: `${MOD}X`, run: () => { setClip({ mode: "cut", keys: outer(ks) }); flash(`${n} item${n === 1 ? "" : "s"} cut — paste them where they go (${MOD}V)`); } },
      { label: n > 1 ? `Copy ${n} items` : "Copy", icon: "copy", keys: `${MOD}C`, run: () => { setClip({ mode: "copy", keys: outer(ks) }); flash(`${n} item${n === 1 ? "" : "s"} copied — paste with ${MOD}V`); } },
      ...(oneFolder && clip ? [{ label: `Paste into “${oneFolder.name}”`, icon: "paste", run: () => void paste(oneFolder.id) } as MenuItem] : []),
      { label: "Duplicate", icon: "dup", keys: `${MOD}D`, run: () => void copyTo(ks, cwd) },
      "sep",
      { label: n > 1 ? `Delete ${n} items` : "Delete", icon: "trash", keys: "⌫", danger: true, run: () => setAsk(ks) },
    ];
    setMenu({ ...at, items: tidy(items) });
  };
  const bgMenu = (at: { x: number; y: number }, target: string | null = cwd) => {
    setSel(new Set());
    const items: MenuItem[] = [
      { label: "New folder", icon: "plusf", keys: `${MAC ? "⇧⌘" : "Ctrl+Shift+"}N`, run: () => void newFolder(target) },
      { label: "Upload files", icon: "upload", run: () => { uploadTo.current = target; inputRef.current?.click(); } },
      { label: clip ? `Paste ${clip.keys.length} item${clip.keys.length === 1 ? "" : "s"}` : "Paste", icon: "paste", keys: `${MOD}V`, disabled: !clip, run: () => void paste(target) },
      "sep",
      { label: "Select all", icon: "all", keys: `${MOD}A`, disabled: !rows.length, run: () => setSel(new Set(rowKeys)) },
      { label: view === "grid" ? "View as list" : "View as cards", icon: view === "grid" ? "list" : "grid", run: () => setView(view === "grid" ? "list" : "grid") },
      "sep",
      ...(["name", "kind", "date", "size"] as SortK[]).map((k) => ({ label: `Sort by ${k === "date" ? "date added" : k}${sort.k === k ? (sort.asc ? "  ↑" : "  ↓") : ""}`, icon: "sort", run: () => setSort(k) }) as MenuItem),
      ...(target ? ["sep" as const, { label: "Go up a level", icon: "up", keys: `${MOD}↑`, run: () => up() } as MenuItem] : []),
    ];
    setMenu({ ...at, items: tidy(items) });
  };
  const tidy = (xs: MenuItem[]) => xs.filter((x, i, a) => x !== "sep" || (i > 0 && a[i - 1] !== "sep" && i < a.length - 1));

  /* ---------- keys ---------- */
  const colsNow = () => {
    const g = areaRef.current?.querySelector<HTMLElement>(".xpl-grid");
    if (!g) return 1;
    return Math.max(1, getComputedStyle(g).gridTemplateColumns.split(" ").filter(Boolean).length);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea") || menu || ask || noteFor) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key;
    const cur = anchor.current && rowKeys.includes(anchor.current) ? anchor.current : [...sel][0];
    const step = (by: number) => {
      if (!rowKeys.length) return;
      const i = cur ? rowKeys.indexOf(cur) : -1;
      const j = Math.max(0, Math.min(rowKeys.length - 1, i < 0 ? 0 : i + by));
      const nk = rowKeys[j];
      if (e.shiftKey && anchor.current) {
        const a = rowKeys.indexOf(anchor.current);
        setSel(new Set(rowKeys.slice(Math.min(a, j), Math.max(a, j) + 1)));
      } else { setSel(new Set([nk])); anchor.current = nk; }
      areaRef.current?.querySelector(`[data-key="${nk}"]`)?.scrollIntoView({ block: "nearest" });
    };
    if (mod && k.toLowerCase() === "a") { e.preventDefault(); setSel(new Set(rowKeys)); }
    else if (mod && k.toLowerCase() === "c" && sel.size) { e.preventDefault(); setClip({ mode: "copy", keys: outer([...sel]) }); flash(`${sel.size} item${sel.size === 1 ? "" : "s"} copied`); }
    else if (mod && k.toLowerCase() === "x" && sel.size) { e.preventDefault(); setClip({ mode: "cut", keys: outer([...sel]) }); flash(`${sel.size} item${sel.size === 1 ? "" : "s"} cut`); }
    else if (mod && k.toLowerCase() === "v" && clip) { e.preventDefault(); void paste(sel.size === 1 && isD([...sel][0]) && e.shiftKey ? idOf([...sel][0]) : cwd); }
    else if (mod && k.toLowerCase() === "d" && sel.size) { e.preventDefault(); void copyTo([...sel], cwd); }
    else if (mod && e.shiftKey && k.toLowerCase() === "n") { e.preventDefault(); void newFolder(cwd); }
    else if (mod && k === "ArrowUp") { e.preventDefault(); up(); }
    else if (mod && k === "ArrowDown" && cur) { e.preventDefault(); openKey(cur); }
    else if (mod && k === "[") { e.preventDefault(); back(); }
    else if (mod && k === "]") { e.preventDefault(); fwd(); }
    else if (k === "Enter" && sel.size === 1) { e.preventDefault(); openKey([...sel][0]); }
    else if (k === "F2" && sel.size === 1) { e.preventDefault(); setRenaming([...sel][0]); }
    else if ((k === "Delete" || k === "Backspace") && sel.size) { e.preventDefault(); setAsk([...sel]); }
    else if (k === "Escape") { if (sel.size) setSel(new Set()); else if (clip) setClip(null); }
    else if (k === "ArrowRight") { e.preventDefault(); step(1); }
    else if (k === "ArrowLeft") { e.preventDefault(); step(-1); }
    else if (k === "ArrowDown") { e.preventDefault(); step(view === "grid" ? colsNow() : 1); }
    else if (k === "ArrowUp") { e.preventDefault(); step(view === "grid" ? -colsNow() : -1); }
  };

  /* ---------- pieces ---------- */
  const cutSet = useMemo(() => new Set(clip?.mode === "cut" ? clip.keys : []), [clip]);
  /** The name being edited (a plain render function: a component made here would start over on every render). */
  const renameBox = (k: Key, value: string) => (
    <input className="xpl-ren" autoFocus defaultValue={value} spellCheck={false}
      onFocus={(e) => { const v = e.target.value; const dot = !isD(k) ? v.lastIndexOf(".") : -1; e.target.setSelectionRange(0, dot > 0 ? dot : v.length); }}
      onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") void rename(k, (e.target as HTMLInputElement).value); if (e.key === "Escape") { setRenaming(null); rootRef.current?.focus({ preventScroll: true }); } }}
      onBlur={(e) => void rename(k, e.target.value)} />
  );
  const placeName = (r: Row) => {
    const parent = r.kind === "folder" ? (r.f as Folder).parent_id : (r.f as CFile).folder_id;
    const p = pathOf(parent ?? null);
    return p.length ? p.map((x) => x.name).join(" › ") : "Directory";
  };
  const itemProps = (r: Row) => ({
    "data-key": r.key,
    className: `${sel.has(r.key) ? "is-sel" : ""} ${cutSet.has(r.key) ? "is-cut" : ""} ${dropOn === r.key ? "is-drop" : ""} ${drag?.includes(r.key) ? "is-drag" : ""}`,
    draggable: renaming !== r.key,
    onMouseDown: (e: React.MouseEvent) => pickDown(e, r.key),
    onClick: (e: React.MouseEvent) => pickClick(e, r.key),
    onDoubleClick: () => openKey(r.key),
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); itemMenu(r.key, { x: e.clientX, y: e.clientY }); },
    onDragStart: (e: React.DragEvent) => dragStart(e, r.key),
    onDragEnd: dragEnd,
    ...(r.kind === "folder" ? dropProps((r.f as Folder).id, r.key) : {}),
    title: r.kind === "file" && (r.f as CFile).note ? (r.f as CFile).note! : undefined,
  });

  /* the tree on the left */
  const tree = (parent: string | null, depth: number): ReactNode => (kids.get(parent) ?? []).map((f) => {
    const hasKids = (kids.get(f.id)?.length ?? 0) > 0;
    const open = openTree.has(f.id);
    const tag = `tree:${f.id}`;
    return (
      <div key={f.id} className="xpl-tn">
        <div className={`xpl-tr ${cwd === f.id && !searching ? "is-on" : ""} ${dropOn === tag ? "is-drop" : ""}`} style={{ ["--d" as string]: depth } as CSSProperties}
          onClick={() => go(f.id)} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); bgMenu({ x: e.clientX, y: e.clientY }, f.id); }}
          draggable onDragStart={(e) => { setSel(new Set([dk(f.id)])); dragStart(e, dk(f.id)); }} onDragEnd={dragEnd}
          {...dropProps(f.id, tag)}>
          <button type="button" className={`xpl-tchev ${hasKids ? "" : "is-none"} ${open ? "is-open" : ""}`} onClick={(e) => { e.stopPropagation(); toggleTree(f.id); }} tabIndex={-1} aria-label={open ? "Fold" : "Unfold"}>
            <Ic d="chev" s={12} />
          </button>
          <FolderArt size={18} open={dropOn === tag || cwd === f.id} />
          <span className="xpl-tl">{f.name}</span>
        </div>
        {hasKids && open && <div className="xpl-tk">{tree(f.id, depth + 1)}</div>}
      </div>
    );
  });

  const path = pathOf(cwd);
  const selFiles = [...sel].filter((k) => !isD(k)).map((k) => files.find((f) => f.id === idOf(k))).filter(Boolean) as CFile[];
  const selSize = selFiles.reduce((t, f) => t + (f.size_bytes ?? 0), 0) + [...sel].filter(isD).reduce((t, k) => t + deepSize(idOf(k)), 0);
  const here = cwd ? byId.get(cwd)?.name ?? "this folder" : "the top of the directory";
  const askKeys = ask ? outer(ask) : [];
  const askInside = askKeys.filter(isD).reduce((t, k) => { const s = subtree(idOf(k)); return t + (s.size - 1) + files.filter((f) => f.folder_id && s.has(f.folder_id)).length; }, 0);

  return (
    <div className={`xpl is-${view} ${drag ? "is-dragging" : ""} ${box ? "is-boxing" : ""}`} ref={rootRef} tabIndex={0} onKeyDown={onKey}
      onDragEnter={(e) => { if (isOs(e)) setOsOver(true); }}
      onDragLeave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOsOver(false); }}
      onDrop={() => setOsOver(false)}>
      {/* ---------- the bar ---------- */}
      <div className="xpl-bar">
        {title && <div className="xpl-title" title={hint}><span className="xpl-title-ico"><Ic d="folder" s={17} /></span><b>{title}</b></div>}
        <div className="xpl-nav">
          <button type="button" onClick={back} disabled={!hist.back.length} title={`Back (${MOD}[)`} aria-label="Back"><Ic d="back" /></button>
          <button type="button" onClick={fwd} disabled={!hist.fwd.length} title={`Forward (${MOD}])`} aria-label="Forward"><Ic d="fwd" /></button>
          <button type="button" onClick={up} disabled={!cwd} title={`Up a level (${MOD}↑)`} aria-label="Up a level"><Ic d="up" /></button>
        </div>
        <nav className="xpl-crumbs" aria-label="Where you are">
          <button type="button" className={`xpl-crumb ${!cwd ? "is-cur" : ""} ${dropOn === "crumb:root" ? "is-drop" : ""}`} onClick={() => go(null)} {...dropProps(null, "crumb:root")}
            onContextMenu={(e) => { e.preventDefault(); bgMenu({ x: e.clientX, y: e.clientY }, null); }}>
            <Ic d="home" s={14} />Directory
          </button>
          {path.map((f) => (
            <span key={f.id} className="xpl-crumb-w">
              <Ic d="chev" s={12} />
              <button type="button" className={`xpl-crumb ${cwd === f.id ? "is-cur" : ""} ${dropOn === `crumb:${f.id}` ? "is-drop" : ""}`} onClick={() => go(f.id)} {...dropProps(f.id, `crumb:${f.id}`)}
                onContextMenu={(e) => { e.preventDefault(); bgMenu({ x: e.clientX, y: e.clientY }, f.id); }}>{f.name}</button>
            </span>
          ))}
        </nav>
        <label className={`xpl-search ${q ? "has-q" : ""}`}>
          <Ic d="search" s={15} />
          <input value={q} onChange={(e) => { setQ(e.target.value); setSel(new Set()); }} placeholder="Search the directory" onKeyDown={(e) => { if (e.key === "Escape") { setQ(""); rootRef.current?.focus(); } }} />
          {q && <button type="button" onClick={() => setQ("")} aria-label="Clear"><Ic d="x" s={13} /></button>}
        </label>
        <div className="xpl-views" role="tablist" aria-label="View">
          <button type="button" role="tab" aria-selected={view === "grid"} className={view === "grid" ? "is-on" : ""} onClick={() => setView("grid")} title="Cards"><Ic d="grid" s={15} /></button>
          <button type="button" role="tab" aria-selected={view === "list"} className={view === "list" ? "is-on" : ""} onClick={() => setView("list")} title="List"><Ic d="list" s={15} /></button>
        </div>
        {extra}
        <ApplyTemplateMenu clientId={clientId} parentId={cwd} parentName={cwd ? byId.get(cwd)?.name ?? null : null} folders={folders}
          onApplied={(all, msg) => { setFolders(all as Folder[]); flash(msg); }} />
        <button type="button" className="xpl-btn" onClick={() => void newFolder(cwd)} title={`New folder (${MAC ? "⇧⌘" : "Ctrl+Shift+"}N)`}><Ic d="plusf" s={15} />New folder</button>
        <button type="button" className="xpl-btn is-primary" onClick={() => { uploadTo.current = cwd; inputRef.current?.click(); }}><Ic d="upload" s={15} />Upload</button>
        <input ref={inputRef} type="file" multiple hidden onChange={(e) => { if (e.target.files) void upload(e.target.files, uploadTo.current); }} />
      </div>

      {err && <p className="xpl-err" role="alert">{err}<button type="button" onClick={() => setErr(null)} aria-label="Dismiss"><Ic d="x" s={13} /></button></p>}

      <div className="xpl-body">
        {/* ---------- the tree ---------- */}
        <aside className="xpl-side" aria-label="Folders">
          <div className={`xpl-tr is-root ${!cwd && !searching ? "is-on" : ""} ${dropOn === "tree:root" ? "is-drop" : ""}`} onClick={() => go(null)}
            onContextMenu={(e) => { e.preventDefault(); bgMenu({ x: e.clientX, y: e.clientY }, null); }} {...dropProps(null, "tree:root")}>
            <span className="xpl-tchev is-none" />
            <span className="xpl-thome"><Ic d="home" s={14} /></span>
            <span className="xpl-tl">Directory</span>
            <em>{folders.length + files.length}</em>
          </div>
          <div className="xpl-tk">{tree(null, 1)}</div>
        </aside>

        {/* ---------- the folder ---------- */}
        <div className="xpl-main">
        <div className={`xpl-area ${osOver ? "is-os" : ""} ${dropOn === "area" ? "is-drop" : ""}`} ref={areaRef}
          onMouseDown={startBox}
          onContextMenu={(e) => { if ((e.target as HTMLElement).closest("[data-key]")) return; e.preventDefault(); bgMenu({ x: e.clientX, y: e.clientY }); }}
          {...dropProps(cwd, "area")}>
          {searching && <div className="xpl-searchnote">{rows.length ? `${rows.length} found for “${q.trim()}” in the whole directory` : `Nothing called “${q.trim()}”`}</div>}
          {!loaded ? (
            <div className="xpl-skel">{Array.from({ length: 8 }, (_, i) => <span key={i} />)}</div>
          ) : !rows.length && !searching ? (
            <div className="xpl-empty">
              <FolderArt size={88} />
              <b>{cwd ? "This folder is empty" : "Build this client's directory"}</b>
              <span>Drop files here, right-click for a new folder, or add a standard structure with <em>Templates</em>.</span>
              <div>
                <button type="button" className="xpl-btn" onClick={() => void newFolder(cwd)}><Ic d="plusf" s={15} />New folder</button>
                <button type="button" className="xpl-btn is-primary" onClick={() => { uploadTo.current = cwd; inputRef.current?.click(); }}><Ic d="upload" s={15} />Upload files</button>
              </div>
            </div>
          ) : view === "grid" ? (
            <div className="xpl-grid">
              {rows.map((r, i) => (
                <div key={r.key} {...itemProps(r)} className={`xpl-card is-${r.kind} ${itemProps(r).className}`} style={{ ["--i" as string]: Math.min(i, 24) } as CSSProperties}>
                  <span className="xpl-card-art">
                    {r.kind === "folder" ? <FolderArt size={62} open={dropOn === r.key} count={countIn((r.f as Folder).id)} /> : <FileArt f={r.f as CFile} thumb={thumbs[(r.f as CFile).id]} size={58} />}
                    {r.kind === "file" && (r.f as CFile).note && <i className="xpl-notedot" />}
                  </span>
                  {renaming === r.key ? renameBox(r.key, r.f.name) : <b className="xpl-card-n">{r.f.name}</b>}
                  {/* a folder's count is already on its icon: no second count under the name */}
                  {(searching || r.kind !== "folder") && <small>{searching ? placeName(r) : [prettySize((r.f as CFile).size_bytes), fmtDate((r.f as CFile).created_at)].filter(Boolean).join(" · ")}</small>}
                </div>
              ))}
            </div>
          ) : (
            <div className="xpl-list" role="grid">
              <div className="xpl-head" role="row">
                {([["name", "Name"], ["kind", "Kind"], ["size", "Size"], ["date", "Added"]] as [SortK, string][]).map(([k, l]) => (
                  <button key={k} type="button" className={`xpl-h-${k} ${sort.k === k ? "is-on" : ""}`} onClick={() => setSort(k)}>
                    {l}{sort.k === k && <span className={`xpl-h-arrow ${sort.asc ? "" : "is-desc"}`}>↑</span>}
                  </button>
                ))}
              </div>
              {rows.map((r, i) => {
                const f = r.f as any;
                return (
                  <div key={r.key} role="row" {...itemProps(r)} className={`xpl-row is-${r.kind} ${itemProps(r).className}`} style={{ ["--i" as string]: Math.min(i, 24) } as CSSProperties}>
                    <span className="xpl-c-name">
                      <span className="xpl-c-art">{r.kind === "folder" ? <FolderArt size={26} open={dropOn === r.key} /> : <FileArt f={f} thumb={thumbs[f.id]} size={26} />}</span>
                      {renaming === r.key ? renameBox(r.key, f.name) : (
                        <span className="xpl-c-t"><b>{f.name}</b>{searching && <small>{placeName(r)}</small>}</span>
                      )}
                      {r.kind === "file" && f.note && <i className="xpl-noteflag" title={f.note}><Ic d="note" s={12} /></i>}
                    </span>
                    <span className="xpl-c-kind">{r.kind === "folder" ? "Folder" : kindOf(f.name, f.mime).word}</span>
                    <span className="xpl-c-size">{r.kind === "folder" ? `${countIn(f.id)} item${countIn(f.id) === 1 ? "" : "s"}` : prettySize(f.size_bytes) || "—"}</span>
                    <span className="xpl-c-date">{fmtDate(f.created_at)}</span>
                  </div>
                );
              })}
            </div>
          )}
          {box && (Math.abs(box.x1 - box.x0) > 3 || Math.abs(box.y1 - box.y0) > 3) && (
            <span className="xpl-box" style={{ left: Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }} />
          )}
          {osOver && !drag && <div className="xpl-osdrop"><Ic d="upload" s={22} /><b>Drop to upload</b><span>into {dropOn?.startsWith("d:") ? `“${byId.get(idOf(dropOn))?.name}”` : here}</span></div>}
        </div>
          {/* the status line, inside the folder card */}
          <div className="xpl-status">
            <span>{rows.length} item{rows.length === 1 ? "" : "s"}{sel.size ? <> · <b>{sel.size} picked</b>{selSize ? ` · ${prettySize(selSize)}` : ""}</> : null}</span>
            {clip && <span className="xpl-clip"><Ic d={clip.mode === "cut" ? "cut" : "copy"} s={13} />{clip.keys.length} {clip.mode === "cut" ? "cut" : "copied"} — {MOD}V pastes into {here}<button type="button" onClick={() => setClip(null)} aria-label="Forget"><Ic d="x" s={12} /></button></span>}
            <span className="xpl-tipline">Right-click for more · drag to move ({MAC ? "⌥" : "Alt"} to copy) · Shift / {MAC ? "⌘" : "Ctrl"} to pick several</span>
          </div>
        </div>
      </div>


      {busy && <div className="xpl-busy" role="status"><i style={{ ["--p" as string]: `${Math.round((busy.done / Math.max(1, busy.n)) * 100)}%` } as CSSProperties} />Working… {busy.done} / {busy.n}</div>}
      {toast && !busy && <div className="xpl-toast" role="status">{toast}</div>}
      {menu && <Menu at={{ x: menu.x, y: menu.y }} items={menu.items} onClose={() => setMenu(null)} />}

      {ask && createPortal(
        <div className="xpl-modal-back" onMouseDown={() => setAsk(null)}>
          <div className="xpl-modal" role="alertdialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
            <span className="xpl-modal-ico is-danger"><Ic d="trash" s={22} /></span>
            <b>Delete {askKeys.length === 1 ? `“${(askKeys[0] && (isD(askKeys[0]) ? byId.get(idOf(askKeys[0]))?.name : files.find((f) => f.id === idOf(askKeys[0]))?.name)) ?? "it"}”` : `${askKeys.length} items`}?</b>
            <p>{askInside ? `${askInside} more inside ${askKeys.filter(isD).length === 1 ? "that folder" : "those folders"} go too. ` : ""}This can't be undone.</p>
            <div>
              <button type="button" className="xpl-btn" onClick={() => setAsk(null)} autoFocus>Cancel</button>
              <button type="button" className="xpl-btn is-danger" onClick={() => void remove(ask)}>Delete</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {noteFor && (() => {
        const f = files.find((x) => x.id === noteFor);
        if (!f) return null;
        return createPortal(
          <div className="xpl-modal-back" onMouseDown={() => setNoteFor(null)}>
            <form className="xpl-modal is-note" onMouseDown={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void saveNote(f.id, (e.currentTarget.elements.namedItem("note") as HTMLTextAreaElement).value); }}>
              <span className="xpl-modal-ico"><Ic d="note" s={20} /></span>
              <b>Note on “{f.name}”</b>
              <textarea name="note" defaultValue={f.note ?? ""} autoFocus placeholder="What's in this file? Shown when you point at it." rows={4}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void saveNote(f.id, (e.target as HTMLTextAreaElement).value); } if (e.key === "Escape") setNoteFor(null); }} />
              <div>
                <button type="button" className="xpl-btn" onClick={() => setNoteFor(null)}>Cancel</button>
                <button type="submit" className="xpl-btn is-primary">Save note</button>
              </div>
            </form>
          </div>,
          document.body,
        );
      })()}
    </div>
  );
}
