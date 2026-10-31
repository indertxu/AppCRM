/* eslint-disable @typescript-eslint/no-explicit-any */
import { Fragment, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../api/supabase";
import Select from "../../framework/Select";
import { setLeaveGuard, loadDepartments, deptName, deptInfo, DEFAULT_DEPARTMENTS } from "../../framework/pageAccess";
import {
  listPipelines, createPipeline, savePipelineOrder, pipelineUsage, deletePipelineSafely, renewalPipelineOf, setRenewalPipeline,
  loadPipeline, loadPhasesByPipeline, syncPipelineToBlueprint, orderPhases,
  listFolders, createFolder, renameFolder, moveFolder, deleteFolder, setPipelineFolder, duplicatePipeline,
  diffDraft, savePipelineDraft,
  type Pipeline, type PipelineFolder, type PipelineDraft, type Phase, type PipelineUsage,
} from "./pipelineApi";
import { loadBlueprintData, type Blueprint } from "./blueprintsApi";
import "./PipelinePage.css";

interface Props { onBack: () => void; }

// Fixed departments — SVG icons (centre perfectly, unlike unicode glyphs)
/** The company's departments (Settings → Organization): name and colour from there. */
const deptLabel = (k: string) => deptName(k) || k;
const deptColor = (k: string) => deptInfo(k)?.color ?? DEFAULT_DEPARTMENTS.find((d) => d.key === k)?.color ?? "#5a7d6d";
/** Departments carry a colour only (the badge is a coloured dot). */
const DeptIcon = (_: { k: string }) => null;

/** Room between two steps of the line (stored as the phase's position, so every other screen reads the same order). */
const STEP_Y = 140;
const newId = () => (crypto as any).randomUUID?.() ?? "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c: string) => (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16));
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// ---- folders: helpers shared by the list and the editor ----
const COLLAPSED_KEY = "pl-folders-collapsed";
const readCollapsed = (): Set<string> => {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || "[]")); } catch { return new Set(); }
};
function folderTree(folders: PipelineFolder[]) {
  const ids = new Set(folders.map((f) => f.id));
  const parentOf = (f: PipelineFolder) => (f.parent_id && ids.has(f.parent_id) && f.parent_id !== f.id ? f.parent_id : null);
  const byId = new Map(folders.map((f) => [f.id, f]));
  const kids = (parent: string | null) => folders.filter((f) => parentOf(f) === parent)
    .sort((a, b) => ((a.sort_order ?? 1e9) - (b.sort_order ?? 1e9)) || a.name.localeCompare(b.name));
  /** Folder ids from the top down to `id` (guards against a loop in bad data). */
  const chain = (id: string | null) => {
    const out: string[] = [];
    let cur = id ? byId.get(id) : undefined;
    while (cur && out.length < 64 && !out.includes(cur.id)) { out.unshift(cur.id); const p = parentOf(cur); cur = p ? byId.get(p) : undefined; }
    return out;
  };
  const path = (id: string | null) => chain(id).map((x) => byId.get(x)?.name || "Folder").join(" › ");
  /** Is `id` the same as, or inside, `ancestor`? */
  const within = (id: string | null, ancestor: string) => chain(id).includes(ancestor);
  const has = (id: string | null | undefined) => !!id && ids.has(id);
  /** Every folder, top down, with its depth — for pickers. */
  const flat = () => {
    const out: { f: PipelineFolder; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => kids(parent).forEach((f) => { if (depth < 64) { out.push({ f, depth }); walk(f.id, depth + 1); } });
    walk(null, 0);
    return out;
  };
  return { kids, path, within, has, flat, byId };
}

const FolderIco = ({ open }: { open?: boolean }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {open
      ? <path d="M3 8V6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1M3 8h18l-2 10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      : <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />}
  </svg>
);

const Ico = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const IC = {
  plus: "M12 5v14M5 12h14",
  edit: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  folderPlus: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10v6M9 13h6",
  move: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM10 13h6M13 10l3 3-3 3",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3",
  blank: "M6 3h9l4 4v14H6zM14 3v5h5",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  chev: "M9 6l6 6-6 6",
  back: "M15 6l-6 6 6 6",
  check: "M5 12l5 5 9-10",
  renew: "M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5",
};

/** A small menu next to the button that opened it: Esc or a click outside closes it, ↑ ↓ move. */
function Popover({ anchor, onClose, width = 248, align = "end", children, label }: {
  anchor: DOMRect; onClose: () => void; width?: number; align?: "start" | "end"; children: ReactNode; label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    const away = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const t = window.setTimeout(() => document.addEventListener("mousedown", off), 0);
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", away, true);
    window.setTimeout(() => ref.current?.querySelector<HTMLElement>("input, button:not(:disabled)")?.focus(), 0);
    return () => { window.clearTimeout(t); document.removeEventListener("mousedown", off); window.removeEventListener("keydown", key, true); window.removeEventListener("scroll", away, true); };
  }, [onClose]);
  const left = align === "end" ? Math.min(anchor.right - width, window.innerWidth - width - 8) : Math.min(anchor.left, window.innerWidth - width - 8);
  const below = anchor.bottom + 8 + 360 < window.innerHeight;
  return createPortal(
    <div ref={ref} className="plv-pop" role="menu" aria-label={label}
      style={{ left: Math.max(8, left), width, ...(below ? { top: anchor.bottom + 6 } : { bottom: window.innerHeight - anchor.top + 6 }) }}
      onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const bs = Array.from(ref.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? []);
        const i = bs.indexOf(document.activeElement as HTMLElement);
        bs[(i + (e.key === "ArrowDown" ? 1 : bs.length - 1)) % bs.length]?.focus();
      }}>
      {children}
    </div>,
    document.body,
  );
}
const MenuItem = ({ icon, label, hint, danger, onClick, disabled, current }: { icon?: string; label: string; hint?: string; danger?: boolean; onClick: () => void; disabled?: boolean; current?: boolean }) => (
  <button type="button" role="menuitem" className={`plv-mi ${danger ? "is-danger" : ""} ${current ? "is-current" : ""}`} onClick={onClick} disabled={disabled}>
    {icon ? <Ico d={icon} /> : <span className="plv-mi-pad" />}
    <span className="plv-mi-txt"><b>{label}</b>{hint && <small>{hint}</small>}</span>
    {current && <Ico d={IC.check} />}
  </button>
);

type Over = { kind: "pipe"; id: string; after: boolean } | { kind: "folder"; id: string } | { kind: "root" } | null;
const sameOver = (a: Over, b: Over) => JSON.stringify(a) === JSON.stringify(b);
type Pop =
  | { kind: "new"; rect: DOMRect; folder: string | null }
  | { kind: "pipe"; rect: DOMRect; id: string; view?: "move" }
  | { kind: "folder"; rect: DOMRect; id: string; view?: "move" };

export default function PipelinePage({ onBack }: Props) {
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  /** null: the folders table isn't there yet (56_pipeline_folders.sql). */
  const [folders, setFolders] = useState<PipelineFolder[] | null>([]);
  const [phasesBy, setPhasesBy] = useState<Record<string, Phase[]>>({});
  const [loaded, setLoaded] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  /** The open pipeline's editor answers here: "may I leave?" (it asks first when there are unsaved changes). */
  const guard = useRef<((go: () => void) => boolean) | null>(null);
  /** Go somewhere else, past the editor's unsaved-changes question. */
  const leave = (go: () => void) => { if (guard.current?.(go)) return; go(); };
  const [deleting, setDeleting] = useState<Pipeline | null>(null);
  const [delFolder, setDelFolder] = useState<PipelineFolder | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [pop, setPop] = useState<Pop | null>(null);
  const [copyQ, setCopyQ] = useState("");
  const [busy, setBusy] = useState(false);
  // Drag: pipelines reorder (same order for everyone) and go into folders; folders go into folders.
  // Nothing on the page moves while you drag (moving it makes the browser drop the drag).
  const [drag, setDrag] = useState<{ kind: "pipe" | "folder"; id: string } | null>(null);
  const dragRef = useRef<{ kind: "pipe" | "folder"; id: string } | null>(null);
  const [over, setOverState] = useState<Over>(null);
  const setOver = (o: Over) => setOverState((cur) => (sameOver(cur, o) ? cur : o));
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = async () => {
    const [ps, fs, ph] = await Promise.all([
      listPipelines().catch(() => [] as Pipeline[]),
      listFolders().catch(() => null),
      loadPhasesByPipeline().catch(() => ({} as Record<string, Phase[]>)),
    ]);
    setPipelines(ps); setFolders(fs); setPhasesBy(ph); setLoaded(true);
    setPreviewId((cur) => (cur && ps.some((p) => p.id === cur) ? cur : ps[0]?.id ?? null));
  };
  useEffect(() => { refresh(); }, []);

  const tree = useMemo(() => folderTree(folders ?? []), [folders]);
  const hasFolders = (folders ?? []).length > 0;
  const folderOf = (p: Pipeline) => (tree.has(p.folder_id) ? p.folder_id! : null);
  const ql = fold(q.trim());
  const matches = (p: Pipeline) => !ql || fold(p.name || "").includes(ql);
  const countIn = (id: string): number => pipelines.filter((p) => matches(p) && tree.within(folderOf(p), id)).length;
  const saveCollapsed = (n: Set<string>) => { try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...n])); } catch { /* ignore */ } };
  const toggle = (id: string) => setCollapsed((cur) => {
    const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id);
    saveCollapsed(n); return n;
  });
  /** Unfold a folder and every folder above it. */
  const openFolder = (id: string | null) => {
    if (!id) return;
    setCollapsed((cur) => {
      const n = new Set(cur); let changed = false;
      for (const f of (folders ?? [])) if (tree.within(id, f.id) && n.delete(f.id)) changed = true;
      if (changed) saveCollapsed(n);
      return changed ? n : cur;
    });
  };

  const clickRow = (id: string) => { if (previewId !== id) leave(() => setPreviewId(id)); };
  const newBlank = async (folderId: string | null) => {
    setPop(null);
    let p = await createPipeline("Untitled pipeline", folderId);
    if (!p && folderId) p = await createPipeline("Untitled pipeline");
    if (!p) { setMsg("Couldn't create the pipeline: your user isn't allowed to."); return; }
    await refresh(); setPreviewId(p.id);
  };
  /** Start from a copy of another pipeline (its phases, arrows, departments, products). */
  const newCopy = async (src: Pipeline, folderId?: string | null) => {
    setPop(null); setCopyQ("");
    if (busy) return;
    setBusy(true); setMsg(null);
    const r = await duplicatePipeline(src.id, `Copy of ${src.name || "pipeline"}`, folderId);
    setBusy(false);
    if (typeof r === "string") { setMsg(r); return; }
    openFolder(r.folder_id ?? null);
    await refresh(); setPreviewId(r.id);
  };
  const newFolder = async (parentId: string | null) => {
    setPop(null);
    const f = await createFolder("New folder", parentId);
    if (typeof f === "string") { setMsg(f); return; }
    setMsg(null);
    setFolders((cur) => [...(cur ?? []), f]);
    openFolder(parentId);
    setRenaming(f.id);
  };
  const commitRename = async (f: PipelineFolder, name: string) => {
    setRenaming(null);
    const v = name.trim();
    if (!v || v === f.name) return;
    setFolders((cur) => (cur ?? []).map((x) => (x.id === f.id ? { ...x, name: v } : x)));
    const e = await renameFolder(f.id, v);
    if (e) { setMsg(e); refresh(); }
  };
  const movePipe = async (id: string, dest: string | null) => {
    setPop(null);
    setPipelines((ps) => ps.map((p) => (p.id === id ? { ...p, folder_id: dest } : p)));
    openFolder(dest);
    const e = await setPipelineFolder(id, dest);
    setMsg(e); if (e) refresh();
  };
  const moveFolderTo = async (id: string, dest: string | null) => {
    setPop(null);
    if (dest && tree.within(dest, id)) return;               // not into itself or its own sub-folders
    setFolders((fs) => (fs ?? []).map((f) => (f.id === id ? { ...f, parent_id: dest } : f)));
    openFolder(dest);
    const e = await moveFolder(id, dest);
    setMsg(e); if (e) refresh();
  };

  // ---- drag & drop ----
  const startDrag = (e: React.DragEvent, d: { kind: "pipe" | "folder"; id: string }) => {
    e.stopPropagation();
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", d.id); } catch { /* ignore */ }
    dragRef.current = d;
    // after the browser has picked the drag up: changing the page during dragstart cancels it
    window.setTimeout(() => setDrag(d), 0);
  };
  const endDrag = () => { dragRef.current = null; setDrag(null); setOverState(null); };
  const canDropOnFolder = (fid: string) => { const d = dragRef.current; return !!d && !(d.kind === "folder" && tree.within(fid, d.id)); };
  const drop = async (o: Over) => {
    const d = dragRef.current;
    endDrag();
    if (!d || !o) return;
    if (o.kind === "root") { if (d.kind === "pipe") await movePipe(d.id, null); else await moveFolderTo(d.id, null); return; }
    if (o.kind === "folder") { if (d.kind === "pipe") await movePipe(d.id, o.id); else await moveFolderTo(d.id, o.id); return; }
    // on a pipeline: it goes right before / after it, in its folder
    const target = pipelines.find((p) => p.id === o.id);
    if (!target) return;
    const dest = folderOf(target);
    if (d.kind === "folder") { await moveFolderTo(d.id, dest); return; }
    if (d.id === target.id) return;
    const moved = pipelines.find((p) => p.id === d.id);
    const ids = pipelines.map((p) => p.id).filter((id) => id !== d.id);
    ids.splice(ids.indexOf(target.id) + (o.after ? 1 : 0), 0, d.id);
    setPipelines(ids.map((id) => { const p = pipelines.find((x) => x.id === id)!; return id === d.id ? { ...p, folder_id: dest } : p; }));
    let err: string | null = null;
    if (moved && folderOf(moved) !== dest) err = await setPipelineFolder(d.id, dest);
    if (!err) err = await savePipelineOrder(ids);
    setMsg(err); if (err) refresh();
  };
  const dropTarget = (o: Exclude<Over, null>, ok = true) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!dragRef.current || !ok) return;
      e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move";
      if (o.kind === "pipe") {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setOver({ ...o, after: e.clientY > r.top + r.height / 2 });
      } else setOver(o);
    },
    onDrop: (e: React.DragEvent) => {
      if (!dragRef.current || !ok) return;
      e.preventDefault(); e.stopPropagation();
      if (o.kind === "pipe") {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        void drop({ ...o, after: e.clientY > r.top + r.height / 2 });
      } else void drop(o);
    },
  });

  const openPop = (e: React.MouseEvent, p: Pop) => { e.stopPropagation(); setCopyQ(""); setPop((cur) => (cur && cur.kind === p.kind && (cur as any).id === (p as any).id ? null : p)); };
  const moreBtn = (label: string, p: { kind: "pipe" | "folder"; id: string }) => (
    <button type="button" className={`plv-more ${pop && pop.kind === p.kind && (pop as any).id === p.id ? "is-open" : ""}`} aria-label={label} aria-haspopup="menu"
      onClick={(e) => openPop(e, { ...p, rect: e.currentTarget.getBoundingClientRect() })}
      onDoubleClick={(e) => e.stopPropagation()} draggable={false} onDragStart={(e) => e.preventDefault()}>
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5.5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="18.5" cy="12" r="1.7" /></svg>
    </button>
  );

  /** A name too long for its row slides left on hover, so the end of it shows too. */
  const slideName = (row: HTMLElement, on: boolean) => {
    const box = row.querySelector<HTMLElement>(".plv-row-name"), txt = row.querySelector<HTMLElement>(".plv-row-txt");
    if (!box || !txt) return;
    const over = txt.scrollWidth - box.clientWidth;
    const shift = on && over > 0 ? over + 14 : 0;   // + room past the soft edge, so the last letter is clear
    txt.style.transitionDuration = `${on ? Math.max(0.35, shift / 90) : 0.3}s`;
    txt.style.transitionDelay = on && shift ? "0.25s" : "0s";
    txt.style.transform = shift ? `translateX(-${shift}px)` : "";
    box.classList.toggle("is-sliding", on && shift > 0);
  };
  const pipeRow = (p: Pipeline) => {
    const isOver = over?.kind === "pipe" && over.id === p.id && drag?.id !== p.id;
    return (
      <div
        key={p.id}
        className={`plv-row ${previewId === p.id ? "is-active" : ""} ${drag?.id === p.id ? "is-dragging" : ""} ${isOver ? (over!.kind === "pipe" && over!.after ? "is-after" : "is-before") : ""}`}
        onClick={() => clickRow(p.id)}
        onMouseEnter={(e) => slideName(e.currentTarget, true)}
        onMouseLeave={(e) => slideName(e.currentTarget, false)}
        title={p.name || "Untitled pipeline"}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); clickRow(p.id); } }}
        tabIndex={0} role="treeitem" aria-selected={previewId === p.id}
        draggable
        onDragStart={(e) => startDrag(e, { kind: "pipe", id: p.id })}
        onDragEnd={endDrag}
        {...dropTarget({ kind: "pipe", id: p.id, after: false })}
      >
        <span className="plv-row-main">
          <span className="plv-row-top">
            <span className="plv-row-name"><span className="plv-row-txt">{p.name || "Untitled pipeline"}</span></span>
            {p.is_sales && (
              <span className="plv-sales" title="Sales pipeline — shown in the deals tracker" aria-label="Sales pipeline">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 17l6-6 4 4 8-8M15 7h6v6" /></svg>
              </span>
            )}
          </span>
        </span>
        {moreBtn(`Actions for ${p.name}`, { kind: "pipe", id: p.id })}
      </div>
    );
  };

  const folderBlock = (f: PipelineFolder): ReactNode => {
    const n = countIn(f.id);
    if (ql && n === 0) return null;                          // searching: only folders with a match
    const open = !!ql || !collapsed.has(f.id);
    const ok = canDropOnFolder(f.id);
    const isOver = over?.kind === "folder" && over.id === f.id;
    const kids = tree.kids(f.id).map(folderBlock).filter(Boolean);
    const pipes = pipelines.filter((p) => folderOf(p) === f.id && matches(p));
    return (
      <div key={f.id} className={`plv-folder ${open ? "is-open" : ""} ${isOver ? "is-over" : ""} ${drag?.id === f.id ? "is-dragging" : ""}`} role="treeitem" aria-expanded={open}>
        <div className="plv-folder-head"
          onClick={() => { if (renaming !== f.id) toggle(f.id); }}
          draggable={renaming !== f.id}
          onDragStart={(e) => startDrag(e, { kind: "folder", id: f.id })}
          onDragEnd={endDrag}
          {...dropTarget({ kind: "folder", id: f.id }, ok)}>
          <span className="plv-chev" aria-hidden="true"><Ico d={IC.chev} /></span>
          <span className="plv-folder-ico" aria-hidden="true"><FolderIco open={open} /></span>
          {renaming === f.id ? (
            <input className="plv-folder-input" autoFocus defaultValue={f.name} aria-label="Folder name"
              onFocus={(e) => e.currentTarget.select()}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => commitRename(f, e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setRenaming(null); }
              }} />
          ) : (
            <span className="plv-folder-name" onDoubleClick={(e) => { e.stopPropagation(); setRenaming(f.id); }}>{f.name || "Folder"}</span>
          )}
          <span className="plv-count">{n}</span>
          {moreBtn(`Actions for folder ${f.name}`, { kind: "folder", id: f.id })}
        </div>
        {open && (
          <div className="plv-folder-body">
            {kids}
            {pipes.map(pipeRow)}
            {!kids.length && !pipes.length && (
              <div className={`plv-empty-slot ${isOver ? "is-over" : ""}`} {...dropTarget({ kind: "folder", id: f.id }, ok)}>
                Drag pipelines here
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const roots = tree.kids(null).map(folderBlock).filter(Boolean);
  const loose = pipelines.filter((p) => folderOf(p) === null && matches(p));
  const folderCount = (f: PipelineFolder) => ({
    subs: (folders ?? []).filter((x) => x.id !== f.id && tree.within(x.id, f.id)).length,
    pipes: pipelines.filter((p) => tree.within(folderOf(p), f.id)).length,
  });
  const preview = previewId ? pipelines.find((p) => p.id === previewId) ?? null : null;
  const nFolders = (folders ?? []).length;

  // ---- the menus ----
  const moveList = (current: string | null, apply: (dest: string | null) => void, exclude?: string) => (
    <>
      <MenuItem label="Not in a folder" current={current === null} onClick={() => apply(null)} />
      {tree.flat().filter(({ f }) => !exclude || !tree.within(f.id, exclude)).map(({ f, depth }) => (
        <div key={f.id} style={{ paddingLeft: depth * 14 }}>
          <MenuItem icon={IC.folder} label={f.name || "Folder"} current={current === f.id} onClick={() => apply(f.id)} />
        </div>
      ))}
    </>
  );
  const copyChoices = pipelines.filter((p) => !copyQ || fold(p.name || "").includes(fold(copyQ)));
  let popBody: ReactNode = null;
  if (pop?.kind === "new") {
    popBody = (
      <>
        <MenuItem icon={IC.blank} label="Blank pipeline" hint="Start with no phases" onClick={() => leave(() => newBlank(pop.folder))} />
        {pipelines.length > 0 && (
          <>
            <div className="plv-pop-sep" />
            <span className="plv-pop-k">Start from a copy of</span>
            <div className="plv-pop-search"><Ico d={IC.search} /><input value={copyQ} onChange={(e) => setCopyQ(e.target.value)} placeholder="Find a pipeline" aria-label="Find a pipeline to copy" /></div>
            <div className="plv-pop-list">
              {copyChoices.map((p) => (
                <MenuItem key={p.id} icon={IC.copy} label={p.name || "Untitled pipeline"}
                  hint={[folderOf(p) ? tree.path(folderOf(p)) : null, `${(phasesBy[p.id] ?? []).length} phases`].filter(Boolean).join(" · ")}
                  onClick={() => leave(() => newCopy(p, pop.folder ?? undefined))} />
              ))}
              {!copyChoices.length && <p className="plv-pop-none">No pipeline matches.</p>}
            </div>
          </>
        )}
      </>
    );
  } else if (pop?.kind === "pipe") {
    const p = pipelines.find((x) => x.id === pop.id);
    if (p) popBody = pop.view === "move" ? (
      <>
        <button type="button" className="plv-pop-back" onClick={() => setPop({ ...pop, view: undefined })}><Ico d={IC.back} />Move to folder</button>
        {moveList(folderOf(p), (dest) => movePipe(p.id, dest))}
      </>
    ) : (
      <>
        <MenuItem icon={IC.copy} label="Duplicate" hint="Same phases, under a new name" onClick={() => leave(() => newCopy(p))} />
        {folders !== null && hasFolders && <MenuItem icon={IC.move} label="Move to folder…" onClick={() => setPop({ ...pop, view: "move" })} />}
        <div className="plv-pop-sep" />
        <MenuItem icon={IC.trash} label="Delete…" danger onClick={() => { setPop(null); setDeleting(p); }} />
      </>
    );
  } else if (pop?.kind === "folder") {
    const f = (folders ?? []).find((x) => x.id === pop.id);
    if (f) popBody = pop.view === "move" ? (
      <>
        <button type="button" className="plv-pop-back" onClick={() => setPop({ ...pop, view: undefined })}><Ico d={IC.back} />Move folder to</button>
        {moveList(tree.has(f.parent_id) ? f.parent_id : null, (dest) => moveFolderTo(f.id, dest), f.id)}
      </>
    ) : (
      <>
        <MenuItem icon={IC.plus} label="New pipeline here…" onClick={() => setPop({ kind: "new", rect: pop.rect, folder: f.id })} />
        <MenuItem icon={IC.folderPlus} label="New sub-folder" onClick={() => newFolder(f.id)} />
        <MenuItem icon={IC.edit} label="Rename" onClick={() => { setPop(null); setRenaming(f.id); }} />
        <MenuItem icon={IC.move} label="Move folder…" onClick={() => setPop({ ...pop, view: "move" })} />
        <div className="plv-pop-sep" />
        <MenuItem icon={IC.trash} label="Delete folder…" danger onClick={() => { setPop(null); setDelFolder(f); }} />
      </>
    );
  }

  const isRenewal = !!preview && renewalPipelineOf(pipelines)?.id === preview.id;
  return (
    <div className="pl plv">
      <div className="plv-body">
        <aside className="plv-side" aria-label="Pipelines">
          <div className="plv-acts">
            <button type="button" className="plv-back" onClick={() => leave(onBack)} aria-label="Back to Settings" title="Back to Settings"><Ico d={IC.back} /></button>
            <span className="plv-side-t" title={loaded ? `${pipelines.length} pipelines${nFolders ? ` in ${nFolders} folders` : ""} · the same order for everyone` : undefined}>Pipelines</span>
            {folders !== null && (
              <button type="button" className="plv-icon" onClick={() => newFolder(null)} title="New folder" aria-label="New folder"><Ico d={IC.folderPlus} /></button>
            )}
            <button type="button" className={`plv-new ${pop?.kind === "new" && !pop.folder ? "is-open" : ""}`} disabled={busy} title="New pipeline"
              onClick={(e) => openPop(e, { kind: "new", rect: e.currentTarget.getBoundingClientRect(), folder: null })} aria-haspopup="menu">
              <Ico d={IC.plus} />{busy ? "Copying…" : "New"}
            </button>
          </div>
          {pipelines.length > 5 && (
            <div className="plv-search">
              <Ico d={IC.search} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a pipeline" aria-label="Find a pipeline" />
              {q && <button type="button" onClick={() => setQ("")} aria-label="Clear search">×</button>}
            </div>
          )}
          {msg && <p className="plv-msg" role="alert">{msg}<button type="button" onClick={() => setMsg(null)} aria-label="Dismiss">×</button></p>}
          <div className="plv-tree" role="tree" aria-label="Pipelines"
            onDragOver={(e) => { if (dragRef.current) { e.preventDefault(); setOver(null); } }}
            onDrop={(e) => { if (dragRef.current) { e.preventDefault(); endDrag(); } }}>
            {roots}
            {hasFolders && (loose.length > 0 || drag || !ql) && (
              <div className={`plv-loose ${over?.kind === "root" ? "is-over" : ""}`} {...dropTarget({ kind: "root" })}>
                Not in a folder <span className="plv-count">{loose.length}</span>
              </div>
            )}
            {loose.map(pipeRow)}
            {loaded && !pipelines.length && !hasFolders && <p className="plv-none">No pipelines yet. Create the first one above.</p>}
            {ql && !roots.length && !loose.length && <p className="plv-none">No pipeline matches “{q}”.</p>}
          </div>
          <p className="plv-foot">
            {folders === null
              ? "Drag to reorder. To group pipelines in folders, run 56_pipeline_folders.sql once."
              : "Drag onto a folder to file it, or between two pipelines to reorder."}
          </p>
        </aside>

        {preview ? (
          <PipelineEditor key={preview.id} pipeline={preview} folders={folders} pipelines={pipelines} guard={guard}
            isRenewal={isRenewal} busy={busy}
            onRenewal={async () => { const e = await setRenewalPipeline(isRenewal ? null : preview.id); setMsg(e); await refresh(); }}
            onDuplicate={() => leave(() => newCopy(preview))}
            onBack={onBack} onSaved={refresh} />
        ) : (
          <section className="plv-main"><div className="plv-pv-empty">{loaded ? "Pick a pipeline on the left, or create one." : ""}</div></section>
        )}
      </div>

      {pop && popBody && (
        <Popover anchor={pop.rect} onClose={() => setPop(null)} label="Pipeline actions" width={pop.kind === "new" ? 300 : 248} align={pop.kind === "new" && !(pop as any).folder ? "start" : "end"}>
          {popBody}
        </Popover>
      )}
      {deleting && (
        <DeletePipelineModal
          pipeline={deleting}
          others={pipelines.filter((p) => p.id !== deleting.id)}
          onClose={() => setDeleting(null)}
          onDeleted={async () => { setDeleting(null); await refresh(); }}
        />
      )}
      {delFolder && (
        <DeleteFolderModal folder={delFolder} {...folderCount(delFolder)}
          onClose={() => setDelFolder(null)}
          onConfirm={async () => {
            const e = await deleteFolder(delFolder.id);
            setDelFolder(null); setMsg(e); await refresh();
          }} />
      )}
    </div>
  );
}

// ============================ Delete a folder ============================
function DeleteFolderModal({ folder, subs, pipes, onClose, onConfirm }: {
  folder: PipelineFolder; subs: number; pipes: number; onClose: () => void; onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  return createPortal(
    <div className="pl-del-backdrop" onMouseDown={() => !busy && onClose()}>
      <div className="pl-del" onMouseDown={(e) => e.stopPropagation()} role="alertdialog" aria-modal="true" aria-labelledby="pl-delf-title">
        <span className="pl-del-ico"><FolderIco /></span>
        <span className="pl-del-eyebrow">Delete folder</span>
        <h2 id="pl-delf-title" className="pl-del-title">Delete <b>{folder.name || "Folder"}</b>?</h2>
        <p className="pl-del-sub">
          {subs > 0 && <>Its {subs} sub-folder{subs === 1 ? "" : "s"} go{subs === 1 ? "es" : ""} too. </>}
          {pipes > 0
            ? <>The {pipes} pipeline{pipes === 1 ? "" : "s"} inside move{pipes === 1 ? "s" : ""} to the top level — no pipeline, phase or deal is deleted.</>
            : <>There are no pipelines inside.</>}
        </p>
        <div className="pl-del-actions">
          <button className="pl-del-cancel" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="pl-del-go" disabled={busy} onClick={async () => { setBusy(true); await onConfirm(); }}>{busy ? "Deleting…" : "Delete folder"}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ============================ Delete, with a double confirmation ============================
function DeletePipelineModal({ pipeline, others, onClose, onDeleted }: {
  pipeline: Pipeline; others: Pipeline[]; onClose: () => void; onDeleted: () => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [usage, setUsage] = useState<PipelineUsage | null>(null);
  const [mode, setMode] = useState<"move" | "keep">("move");
  const [moveTo, setMoveTo] = useState<string>(() => (others.find((p) => p.is_sales) ?? others[0])?.id ?? "");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { pipelineUsage(pipeline.id).then(setUsage).catch(() => setUsage({ phases: 0, deals: [], handoversIn: [], pendingHandoffs: 0 })); }, [pipeline.id]);
  useEffect(() => { if (!others.length) setMode("keep"); }, [others.length]);
  useEffect(() => { if (step === 2) setTimeout(() => inputRef.current?.focus(), 60); }, [step]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const name = pipeline.name || "Untitled pipeline";
  const deals = usage?.deals ?? [];
  const open = deals.filter((d) => d.status !== "won" && d.status !== "lost").length;
  const target = others.find((p) => p.id === moveTo);
  const matches = typed.trim().toLowerCase() === name.trim().toLowerCase();
  const go = async () => {
    if (!matches || busy) return;
    setBusy(true); setErr(null);
    const e = await deletePipelineSafely(pipeline.id, { moveDealsTo: deals.length && mode === "move" ? moveTo || null : null });
    setBusy(false);
    if (e) { setErr(e); return; }
    onDeleted();
  };

  return createPortal(
    <div className="pl-del-backdrop" onMouseDown={() => !busy && onClose()}>
      <div className={`pl-del ${step === 2 ? "is-step2" : ""}`} onMouseDown={(e) => e.stopPropagation()} role="alertdialog" aria-modal="true" aria-labelledby="pl-del-title">
        <div className="pl-del-steps" aria-hidden="true"><i className="is-on" /><i className={step === 2 ? "is-on" : ""} /></div>
        <span className="pl-del-ico">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>
        </span>
        <span className="pl-del-eyebrow">{step === 1 ? "Delete pipeline · step 1 of 2" : "Last check · step 2 of 2"}</span>
        <h2 id="pl-del-title" className="pl-del-title">{step === 1 ? <>Delete <b>{name}</b>?</> : "Type the name to delete it"}</h2>

        {step === 1 ? (
          <>
            <p className="pl-del-sub">It goes for good, with its phases, connections, departments and products. This can't be undone.</p>
            {!usage ? <p className="pl-del-loading">Checking what uses it…</p> : (
              <>
                <div className="pl-del-impact">
                  <div><b>{usage.phases}</b><span>{usage.phases === 1 ? "phase" : "phases"}</span></div>
                  <div className={deals.length ? "is-warn" : ""}><b>{deals.length}</b><span>{deals.length === 1 ? "deal" : "deals"}{deals.length ? ` · ${open} open` : ""}</span></div>
                  <div className={usage.handoversIn.length ? "is-warn" : ""}><b>{usage.handoversIn.length}</b><span>handovers into it</span></div>
                  <div className={usage.pendingHandoffs ? "is-warn" : ""}><b>{usage.pendingHandoffs}</b><span>pending handoffs</span></div>
                </div>

                {deals.length > 0 && (
                  <div className="pl-del-sec">
                    <span className="pl-del-lbl">Its {deals.length} {deals.length === 1 ? "deal" : "deals"}</span>
                    {others.length > 0 && (
                      <button type="button" className={`pl-del-opt ${mode === "move" ? "is-on" : ""}`} onClick={() => setMode("move")} aria-pressed={mode === "move"}>
                        <span className="pl-del-radio" />
                        <span className="pl-del-opt-txt"><b>Move them to another pipeline</b><small>They keep their phase when it has the same name there; otherwise they start at the first one.</small></span>
                      </button>
                    )}
                    {mode === "move" && others.length > 0 && (
                      <div className="pl-del-select">
                        <Select value={moveTo} onChange={(v) => v && setMoveTo(v)} placeholder="Choose a pipeline"
                          options={others.map((p) => ({ value: p.id, label: `${p.name}${p.is_sales ? " · sales" : ""}` }))} />
                      </div>
                    )}
                    <button type="button" className={`pl-del-opt ${mode === "keep" ? "is-on" : ""}`} onClick={() => setMode("keep")} aria-pressed={mode === "keep"}>
                      <span className="pl-del-radio" />
                      <span className="pl-del-opt-txt"><b>Keep them without a pipeline</b><small>The deals, notes and documents stay, but they lose their phase.</small></span>
                    </button>
                  </div>
                )}

                {usage.handoversIn.length > 0 && (
                  <div className="pl-del-sec">
                    <span className="pl-del-lbl">These phases hand clients over to it — they'll stop</span>
                    <ul className="pl-del-list">{usage.handoversIn.map((h) => <li key={h.phaseId}>{h.pipelineName} › <b>{h.phaseName}</b></li>)}</ul>
                  </div>
                )}
                {usage.pendingHandoffs > 0 && (
                  <p className="pl-del-note">{usage.pendingHandoffs} sales {usage.pendingHandoffs === 1 ? "handoff is" : "handoffs are"} still waiting to come into this pipeline. {usage.pendingHandoffs === 1 ? "It stays" : "They stay"} in the inbox without a destination, so you can route {usage.pendingHandoffs === 1 ? "it" : "them"} elsewhere.</p>
                )}
              </>
            )}
            <div className="pl-del-actions">
              <button className="pl-del-cancel" onClick={onClose}>Cancel</button>
              <button className="pl-del-next" disabled={!usage || (deals.length > 0 && mode === "move" && !moveTo)} onClick={() => setStep(2)}>Continue</button>
            </div>
          </>
        ) : (
          <>
            <p className="pl-del-sub">
              To confirm, type <code>{name}</code> below.
              {deals.length > 0 && (mode === "move" && target ? ` Its ${deals.length} ${deals.length === 1 ? "deal moves" : "deals move"} to ${target.name}.` : ` Its ${deals.length} ${deals.length === 1 ? "deal stays" : "deals stay"} without a pipeline.`)}
            </p>
            <input ref={inputRef} className={`pl-del-input ${matches ? "is-ok" : ""}`} value={typed} onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") go(); }} placeholder={name} aria-label="Pipeline name" autoComplete="off" spellCheck={false} />
            {err && <p className="pl-del-err">{err}</p>}
            <div className="pl-del-actions">
              <button className="pl-del-cancel" onClick={() => { setStep(1); setTyped(""); setErr(null); }} disabled={busy}>Back</button>
              <button className="pl-del-go" disabled={!matches || busy} onClick={go}>{busy ? "Deleting…" : "Delete pipeline"}</button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ============================ Editor ============================
// The pipeline as a line of steps, top to bottom: add, insert, drag to
// reorder; the line can end in a fork — Won / Lost. Click a step and it opens
// on the right. Everything stays on screen until Save; going elsewhere with
// changes (another pipeline, ‹, the sidebar, closing the tab) asks first:
// Save and leave / Discard (confirmed a second time) / Keep editing.
function PipelineEditor({ pipeline, folders, pipelines, guard, isRenewal, busy, onRenewal, onDuplicate, onBack, onSaved }: {
  pipeline: Pipeline; folders: PipelineFolder[] | null; pipelines: Pipeline[];
  guard: MutableRefObject<((go: () => void) => boolean) | null>;
  isRenewal: boolean; busy: boolean; onRenewal: () => void; onDuplicate: () => void;
  onBack: () => void; onSaved: () => void;
}) {
  const navigate = useNavigate();
  const blank: PipelineDraft = {
    name: pipeline.name, isSales: pipeline.is_sales ?? false, folderId: pipeline.folder_id ?? null,
    source: pipeline.source_blueprint_id ?? null, phases: [], links: [],
  };
  const [base, setBase] = useState<PipelineDraft>(blank);     // as in the database
  const [draft, setDraft] = useState<PipelineDraft>(blank);   // as on screen
  const [loaded, setLoaded] = useState(false);
  const phases = draft.phases, isSales = draft.isSales;
  const setPhases = (fn: (ps: Phase[]) => Phase[]) => setDraft((d) => ({ ...d, phases: fn(d.phases) }));
  const diff = useMemo(() => diffDraft(base, draft), [base, draft]);
  const dirty = loaded && diff.count > 0;

  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [savedOnce, setSavedOnce] = useState(false);
  const [ask, setAsk] = useState<0 | 1 | 2>(0);              // 1: unsaved changes · 2: confirm discard
  const leaveTo = useRef<(() => void) | null>(null);

  const [selId, setSelId] = useState<string | null>(null);
  const [products, setProducts] = useState<{ id: string; name: string }[]>([]);
  const [services, setServices] = useState<{ id: string; name: string }[]>([]);
  const [depts, setDepts] = useState<{ key: string; label: string; color: string }[]>([]);
  const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [nextName, setNextName] = useState("");
  /** The step just added: it pops in, and the name field takes the focus. */
  const [fresh, setFresh] = useState<string | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const others = pipelines.filter((p) => p.id !== pipeline.id);

  /** What the database has now for this pipeline. */
  const readSaved = async (): Promise<PipelineDraft> => {
    const [{ phases, links }, { data }] = await Promise.all([
      loadPipeline(pipeline.id),
      supabase.from("pipelines").select("*").eq("id", pipeline.id).maybeSingle(),
    ]);
    const p = ((data as Pipeline | null) ?? pipeline);
    return { name: p.name ?? "", isSales: p.is_sales ?? false, folderId: p.folder_id ?? null, source: p.source_blueprint_id ?? null, phases, links };
  };
  useEffect(() => {
    let alive = true;
    (async () => {
      // A pipeline made from a blueprint picks up the blueprint's new / removed phases when opened.
      if (pipeline.source_blueprint_id) {
        const bpData = await loadBlueprintData().catch(() => null);
        const bp = bpData?.blueprints.find((b) => b.id === pipeline.source_blueprint_id);
        if (bp) await syncPipelineToBlueprint(pipeline.id, bp.phases.map((p) => ({ id: p.id, name: p.name }))).catch(() => {});
      }
      const b = await readSaved();
      if (!alive) return;
      setBase(b); setDraft(b); setLoaded(true);
    })();
    supabase.from("products").select("id,name").then(({ data }: any) => setProducts(data ?? []));
    supabase.from("services").select("id,name").then(({ data }: any) => setServices(data ?? []));
    loadDepartments(true).then((ds) => {
      setDepts((ds.length ? ds.map((d) => ({ key: d.key, label: d.name, color: d.color })) : DEFAULT_DEPARTMENTS.map((d) => ({ key: d.key, label: d.label, color: d.color }))));
    }).catch(() => {});
    loadBlueprintData().then((d) => setBlueprints(d.blueprints)).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline.id]);

  // ---- save ----
  const save = async (): Promise<boolean> => {
    if (saving) return false;
    if (!dirty) return true;
    setSaving(true); setSaveErr(null);
    const want = draft;
    const err = await savePipelineDraft(pipeline.id, base, want).catch((e) => String(e?.message ?? e));
    const fresh = await readSaved().catch(() => null);
    setSaving(false);
    if (fresh) setBase(fresh);
    if (err) { setSaveErr(err); return false; }
    // Check: what the database has now is what was on screen.
    const left = fresh ? diffDraft(fresh, want).count : 0;
    if (left) {
      setSaveErr(`${left} change${left === 1 ? "" : "s"} didn't stick — the database kept the old value. Your user may not be allowed to edit pipelines.`);
      return false;
    }
    if (fresh) setDraft((cur) => (cur === want ? fresh : cur));   // edits made while saving stay as unsaved
    setSavedOnce(true);
    onSaved();
    return true;
  };

  // ---- leaving ----
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const requestLeave = (go?: () => void) => {
    if (!dirtyRef.current) { (go ?? onBack)(); return; }
    leaveTo.current = go ?? null;
    setAsk(1);
  };
  const leaveNow = () => {
    const go = leaveTo.current; leaveTo.current = null;
    setAsk(0);
    (go ?? onBack)();
  };
  // another pipeline, ‹, a new one: the page asks through `guard`; the sidebar and the search through the leave guard
  useEffect(() => {
    const ask1 = (go: () => void) => { if (!dirtyRef.current) return false; leaveTo.current = go; setAsk(1); return true; };
    guard.current = ask1;
    setLeaveGuard(ask1);
    return () => { if (guard.current === ask1) guard.current = null; setLeaveGuard(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // links anywhere else on the page, and closing the tab
  useEffect(() => {
    if (!dirty) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      e.preventDefault(); e.stopPropagation();
      requestLeave(() => navigate(url.pathname + url.search + url.hash));
    };
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    document.addEventListener("click", onClick, true);
    window.addEventListener("beforeunload", onUnload);
    return () => { document.removeEventListener("click", onClick, true); window.removeEventListener("beforeunload", onUnload); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  // ---- keyboard: Esc closes a menu, then the step on the right; ⌘S / Ctrl+S saves ----
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (!ask) void save(); return; }
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    if (e.key === "Escape") {
      if (e.defaultPrevented || ask) return;
      if (typing) { t!.blur(); return; }
      if (bulkOpen || genOpen) { setBulkOpen(false); setGenOpen(false); return; }
      if (selId) setSelId(null);
    }
  };
  useEffect(() => {
    const f = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, []);

  // ---- the line ----
  const ordered = useMemo(() => orderPhases(draft.phases, draft.links), [draft.phases, draft.links]);
  const win = ordered.find((p) => p.sales_outcome === "win") ?? null;
  const loss = ordered.find((p) => p.sales_outcome === "loss") ?? null;
  const steps = ordered.filter((p) => p !== win && p !== loss);

  /**
   * Put the line in place: each step one under the other, an arrow from each to
   * the next, and from the last into Won and into Lost. Arrows that already
   * exist keep their id, so only what really changed is saved.
   */
  const relink = (list: Phase[], w: Phase | null = win, l: Phase | null = loss, extra?: (d: PipelineDraft) => Partial<PipelineDraft>) =>
    setDraft((d) => {
      const placed = [
        ...list.map((p, i) => ({ ...p, pos_x: 0, pos_y: i * STEP_Y })),
        ...(w ? [{ ...w, pos_x: 0, pos_y: list.length * STEP_Y }] : []),
        ...(l ? [{ ...l, pos_x: 260, pos_y: list.length * STEP_Y }] : []),
      ];
      const pairs: [string, string][] = list.slice(1).map((p, i) => [list[i].id, p.id]);
      const last = list[list.length - 1];
      if (last) { if (w) pairs.push([last.id, w.id]); if (l) pairs.push([last.id, l.id]); }
      const links = pairs.map(([a, b]) => d.links.find((x) => x.from_phase === a && x.to_phase === b) ?? { id: newId(), from_phase: a, to_phase: b });
      return { ...d, ...(extra ? extra(d) : {}), phases: placed, links };
    });
  const blankPhase = (name = "New phase", source: string | null = null, outcome: "win" | "loss" | null = null): Phase => ({
    id: newId(), pipeline_id: pipeline.id, name, pos_x: 0, pos_y: 0, color: null,
    handover_to: null, source_phase_key: source, sales_visible: true, sales_outcome: outcome, close_probability: null,
    deptKeys: [], items: [],
  });
  const insertAt = (index: number, name = "New phase", open = true) => {
    const ph = blankPhase(name);
    const list = [...steps]; list.splice(index, 0, ph);
    relink(list);
    setFresh(ph.id);
    if (open) setSelId(ph.id);
    return ph;
  };
  const addNext = () => {
    const n = nextName.trim();
    if (!n) return;
    insertAt(steps.length, n, false);
    setNextName("");
  };
  const move = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= steps.length || to > steps.length) return;
    const list = [...steps]; const [m] = list.splice(from, 1);
    list.splice(to > from ? to - 1 : to, 0, m);
    relink(list);
  };
  const removePhase = (id: string) => {
    if (selId === id) setSelId(null);
    if (win?.id === id) { takenEnding.current.win = win; relink(steps, null, loss); return; }
    if (loss?.id === id) { takenEnding.current.loss = loss; relink(steps, win, null); return; }
    relink(steps.filter((p) => p.id !== id));
  };
  /** The fork at the end: Won / Lost, one step that ends the line two ways. */
  // taken away and put back before saving: the same Won / Lost come back (with their deals), not new ones
  const takenEnding = useRef<{ win: Phase | null; loss: Phase | null }>({ win: null, loss: null });
  const addEnding = (which: "both" | "win" | "loss" = "both") => {
    const t = takenEnding.current;
    const w = win ?? (which !== "loss" ? t.win ?? blankPhase("Won", null, "win") : null);
    const l = loss ?? (which !== "win" ? t.loss ?? blankPhase("Lost", null, "loss") : null);
    if (w && w !== win) setFresh(w.id);
    relink(steps, w, l);
  };
  const removeEnding = () => {
    if (selId && (selId === win?.id || selId === loss?.id)) setSelId(null);
    takenEnding.current = { win: win ?? takenEnding.current.win, loss: loss ?? takenEnding.current.loss };
    relink(steps, null, null);
  };

  // Generate phases from a blueprint: one step per phase, after the ones there.
  const generateFromBlueprint = (bpId: string) => {
    const bp = blueprints.find((b) => b.id === bpId);
    if (!bp || !bp.phases.length) return;
    const created = bp.phases.map((p, i) => blankPhase(p.name || `Phase ${i + 1}`, p.id));
    relink([...steps, ...created], win, loss, () => ({ source: bpId }));
  };

  // Apply a department / item to every phase at once.
  const applyDeptToAll = (key: string) =>
    setPhases((ps) => ps.map((ph) => ph.deptKeys.includes(key) ? ph : { ...ph, deptKeys: [...ph.deptKeys, key] }));
  const applyItemToAll = (type: "product" | "service", id: string) =>
    setPhases((ps) => ps.map((ph) => ph.items.some((i) => i.type === type && i.id === id) ? ph : { ...ph, items: [...ph.items, { type, id }] }));

  const sel = selId ? phases.find((p) => p.id === selId) ?? null : null;
  const tree = folderTree(folders ?? []);
  const folderOptions = [{ value: "", label: "No folder" }, ...tree.flat().map(({ f, depth }) => ({ value: f.id, label: `${" ".repeat(depth)}${f.name || "Folder"}` }))];
  const pipeName = (id: string | null | undefined) => (id ? pipelines.find((x) => x.id === id)?.name ?? "Handover" : null);

  // ---- what the line shows besides names: department colours, runs, items, figures ----
  const NO_DEPT = "#9fb4aa";
  const tone = (p: Phase) => (p.deptKeys[0] ? deptColor(p.deptKeys[0]) : NO_DEPT);
  const itemName = (it: { type: "product" | "service"; id: string }) =>
    (it.type === "product" ? products : services).find((x) => x.id === it.id)?.name ?? (it.type === "product" ? "Product" : "Service");
  /** Where a department's run of phases starts: its name and how many phases in a row it owns. */
  const runs = new Map<number, { key: string | null; count: number }>();
  steps.forEach((p, i) => {
    const k = p.deptKeys[0] ?? null;
    if (i > 0 && (steps[i - 1].deptKeys[0] ?? null) === k) return;
    let n = 0; while (i + n < steps.length && (steps[i + n].deptKeys[0] ?? null) === k) n++;
    runs.set(i, { key: k, count: n });
  });
  const focusStep = (id: string) => { setSelId(id); window.setTimeout(() => document.getElementById(`pls-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 30); };
  const ItemIco = ({ type }: { type: "product" | "service" }) => type === "product"
    ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7l9-4 9 4-9 4-9-4z" /><path d="M3 7v10l9 4 9-4V7" /></svg>
    : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>;

  /** One step of the line. */
  const step = (p: Phase, i: number) => {
    const on = selId === p.id;
    const hidden = isSales && p.sales_visible === false;
    const prob = p.close_probability;
    return (
      <div key={p.id} id={`pls-${p.id}`}
        className={`pls-step ${on ? "is-sel" : ""} ${fresh === p.id ? "is-fresh" : ""} ${dragIdx === i ? "is-dragging" : ""} ${overIdx === i && dragIdx !== null && dragIdx !== i && dragIdx !== i - 1 ? "is-over" : ""} ${hidden ? "is-hidden" : ""} ${p.sales_outcome ? `is-${p.sales_outcome}` : ""}`}
        style={{ ["--i" as string]: Math.min(i, 14), ["--c" as string]: tone(p) }}
        onDragOver={(e) => { if (dragIdx === null) return; e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setOverIdx(e.clientY > r.top + r.height / 2 ? i + 1 : i); }}
        onDrop={(e) => { if (dragIdx === null) return; e.preventDefault(); if (overIdx !== null) move(dragIdx, overIdx); setDragIdx(null); setOverIdx(null); }}>
        <span className="pls-dot" aria-hidden="true">{i + 1}</span>
        <div className="pls-card" role="button" tabIndex={0} aria-pressed={on}
          onClick={() => setSelId(on ? null : p.id)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelId(on ? null : p.id); } }}>
          <span className="pls-grip" title="Drag to move" draggable
            onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", p.id); } catch { /* */ } window.setTimeout(() => setDragIdx(i), 0); }}
            onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
            onClick={(e) => e.stopPropagation()}>
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>
          </span>
          <span className="pls-main">
            <b>{p.name || "Untitled phase"}</b>
            {p.sales_outcome && <span className={`pls-chip is-${p.sales_outcome}`}>{p.sales_outcome === "win" ? "Won" : "Lost"}</span>}
          </span>
          {/* the details stay quiet: a small sign each, the whole of it on hover */}
          <span className="pls-badges" onClick={(e) => e.stopPropagation()}>
            {p.deptKeys.length > 1 && (
              <span className="pls-badge" tabIndex={0} aria-label={`${p.deptKeys.length} departments`}>
                <span className="pls-dots">{p.deptKeys.slice(0, 3).map((k) => <i key={k} style={{ background: deptColor(k) }} />)}</span>
                <span className="pls-pop"><b>Departments</b>{p.deptKeys.map((k) => <span key={k}><i style={{ background: deptColor(k) }} />{deptLabel(k)}</span>)}</span>
              </span>
            )}
            {p.items.length > 0 && (
              <span className="pls-badge" tabIndex={0} aria-label={`${p.items.length} products and services`}>
                <ItemIco type={p.items.some((it) => it.type === "product") ? "product" : "service"} />{p.items.length}
                <span className="pls-pop"><b>Products &amp; services</b>{p.items.map((it) => <span key={`${it.type}:${it.id}`} className={`is-${it.type}`}><ItemIco type={it.type} />{itemName(it)}</span>)}</span>
              </span>
            )}
            {p.handover_to && (
              <span className="pls-badge is-hand" tabIndex={0} aria-label="Hands the client over">
                <Ico d="M5 12h14M13 6l6 6-6 6" />
                <span className="pls-pop"><b>When it ends</b><span>Hands the client over to <u>{pipeName(p.handover_to)}</u></span></span>
              </span>
            )}
            {hidden && (
              <span className="pls-badge is-off" tabIndex={0} aria-label="Hidden in Sales">
                <Ico d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.2A9.8 9.8 0 0 1 12 5c5 0 9 4.5 10 7-0.4 1-1.3 2.4-2.6 3.7M6.3 6.3C4.2 7.7 2.7 9.8 2 12c1 2.5 5 7 10 7 1.7 0 3.3-.5 4.6-1.3" />
                <span className="pls-pop"><b>Hidden in Sales</b><span>Not shown in the deals tracker</span></span>
              </span>
            )}
          </span>
          {isSales && !p.sales_outcome && (
            <span className={`pls-ring ${prob == null ? "is-none" : ""}`} style={{ ["--p" as string]: prob ?? 0 }} title={prob == null ? "No close probability yet" : `Close probability ${prob}%`}>
              <b>{prob == null ? "—" : `${prob}%`}</b>
            </span>
          )}
          <span className="pls-acts" onClick={(e) => e.stopPropagation()}>
            <button type="button" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label="Move up" title="Move up"><Ico d="M12 19V5M6 11l6-6 6 6" /></button>
            <button type="button" onClick={() => move(i, i + 2)} disabled={i === steps.length - 1} aria-label="Move down" title="Move down"><Ico d="M12 5v14M6 13l6 6 6-6" /></button>
            <button type="button" className="is-del" onClick={() => removePhase(p.id)} aria-label="Delete phase" title="Delete phase"><Ico d={IC.trash} /></button>
          </span>
        </div>
      </div>
    );
  };
  /** Between two steps: a + that slots a new one in. */
  const gap = (index: number) => {
    const run = runs.get(index);
    const c = index < steps.length ? tone(steps[index]) : NO_DEPT;
    return (
    <div className={`pls-gap ${run ? "has-band" : ""} ${overIdx === index && dragIdx !== null && dragIdx !== index && dragIdx !== index - 1 ? "is-over" : ""}`}
      style={{ ["--c" as string]: c, ["--i" as string]: Math.min(index, 14) }}
      onDragOver={(e) => { if (dragIdx === null) return; e.preventDefault(); setOverIdx(index); }}
      onDrop={(e) => { if (dragIdx === null) return; e.preventDefault(); move(dragIdx, index); setDragIdx(null); setOverIdx(null); }}>
      <button type="button" className="pls-ins" onClick={() => insertAt(index)} aria-label="Insert a phase here" title="Insert a phase here"><Ico d={IC.plus} /></button>
      {run && (
        <span className="pls-band" title={`${run.count} phase${run.count === 1 ? "" : "s"} in a row`}><i />{run.key ? deptLabel(run.key) : "No department"}</span>
      )}
    </div>
    );
  };
  /** One side of the fork. */
  const outcome = (p: Phase | null, kind: "win" | "loss") => p ? (
    <button type="button" className={`pls-out is-${kind} ${selId === p.id ? "is-sel" : ""} ${fresh === p.id ? "is-fresh" : ""}`} onClick={() => setSelId(selId === p.id ? null : p.id)}>
      <span className="pls-out-ico" aria-hidden="true">{kind === "win" ? <Ico d="M5 12l5 5 9-10" /> : <Ico d="M6 6l12 12M18 6L6 18" />}</span>
      <span className="pls-out-txt"><b>{p.name || (kind === "win" ? "Won" : "Lost")}</b><em>{kind === "win" ? "Deals that close" : "Deals that don't"}</em></span>
      {p.deptKeys.length > 0 && <span className="pls-out-depts">{p.deptKeys.map((k) => <i key={k} style={{ background: deptColor(k) }} title={deptLabel(k)} />)}</span>}
    </button>
  ) : (
    <button type="button" className={`pls-out is-${kind} is-empty`} onClick={() => addEnding(kind)}>
      <span className="pls-out-ico" aria-hidden="true"><Ico d={IC.plus} /></span>
      <span className="pls-out-txt"><b>Add {kind === "win" ? "Won" : "Lost"}</b><em>{kind === "win" ? "Where closed deals land" : "Where lost deals land"}</em></span>
    </button>
  );

  return (
    <>
      <section className="plv-main pls" aria-label={`Pipeline ${draft.name}`}>
        <div className={`pls-head ${bulkOpen || genOpen ? "is-open" : ""}`}>
          <div className="pls-bar">
            <input className="pls-name" value={draft.name} onChange={(e) => { const v = e.target.value; setDraft((d) => ({ ...d, name: v })); }} aria-label="Pipeline name" placeholder="Pipeline name" />
            {isSales && <span className="pls-pill">Sales</span>}
            {isRenewal && <span className="pls-pill is-renew">Renewals</span>}
            <div className="pls-journey-bar" role="list" aria-label="The phases, in order">
              {loaded && steps.map((p, i) => (
                <button type="button" role="listitem" key={p.id} className={selId === p.id ? "is-on" : ""} style={{ ["--c" as string]: tone(p), ["--i" as string]: i }}
                  onClick={() => focusStep(p.id)} title={`${i + 1}. ${p.name || "Untitled phase"}${p.deptKeys[0] ? ` · ${deptLabel(p.deptKeys[0])}` : ""}`} />
              ))}
              {(win || loss) && (
                <span className="pls-journey-end">
                  {win && <button type="button" className={`is-win ${selId === win.id ? "is-on" : ""}`} onClick={() => focusStep(win.id)} title={win.name || "Won"} />}
                  {loss && <button type="button" className={`is-loss ${selId === loss.id ? "is-on" : ""}`} onClick={() => focusStep(loss.id)} title={loss.name || "Lost"} />}
                </span>
              )}
            </div>
            {saveErr ? <span className="pls-state is-err">Not saved</span>
              : dirty ? <span className="pls-state is-dirty" title={summarize(diff).join(" · ")}>{diff.count} unsaved</span>
              : savedOnce ? <span className="pls-state is-ok"><Ico d={IC.check} />Saved</span> : null}
            <button type="button" className="pls-save" onClick={() => void save()} disabled={!dirty || saving || !loaded} title="Save (⌘S / Ctrl+S)">
              {saving ? "Saving…" : "Save"}
            </button>
            <span className="pls-more" aria-hidden="true"><Ico d="M6 9l6 6 6-6" /></span>
          </div>

          <div className="pls-drawer">
            <div className="pls-group">
              {folders !== null && folders.length > 0 && (
                <label className="pls-field" title="Folder">
                  <Ico d={IC.folder} />
                  <Select size="sm" value={tree.has(draft.folderId) ? draft.folderId! : ""} onChange={(v) => setDraft((d) => ({ ...d, folderId: v || null }))}
                    options={folderOptions} aria-label="Folder" />
                </label>
              )}
              <button type="button" className={`pls-sw ${isSales ? "is-on" : ""}`} role="switch" aria-checked={isSales}
                onClick={() => setDraft((d) => ({ ...d, isSales: !d.isSales }))} title="Show this pipeline in Sales (the deals tracker)">
                <span className="pls-sw-k" aria-hidden="true"><i /></span>Sales
              </button>
              <button type="button" className={`pls-sw is-violet ${isRenewal ? "is-on" : ""}`} role="switch" aria-checked={isRenewal} disabled={busy} onClick={onRenewal}
                title={isRenewal ? "Ended client contracts come back to Sales here, as renewal deals" : "Send ended client contracts here, as renewal deals"}>
                <span className="pls-sw-k" aria-hidden="true"><i /></span>Renewals
              </button>
            </div>
            <div className="pls-group">
              {phases.length > 0 && (
                <div className="pl-menu-wrap">
                  <button type="button" className={`pls-act ${bulkOpen ? "is-on" : ""}`} onClick={() => { setBulkOpen((v) => !v); setGenOpen(false); }} title="Add a department, product or service to every phase">
                    <Ico d="M4 6h16M4 12h16M4 18h10" />To every phase
                  </button>
                  {bulkOpen && (
                    <>
                      <div className="pl-menu-layer" onClick={() => setBulkOpen(false)} />
                      <div className="pl-menu-pop">
                        <span className="pl-menu-title">Add to every phase</span>
                        <label className="pl-menu-lbl">Department</label>
                        <Select value="" onChange={(v) => v && applyDeptToAll(v)} placeholder="Pick department" options={depts.map((d) => ({ value: d.key, label: d.label }))} />
                        <label className="pl-menu-lbl">Product</label>
                        <Select value="" onChange={(v) => v && applyItemToAll("product", v)} placeholder="Pick product" options={products.map((p) => ({ value: p.id, label: p.name }))} />
                        <label className="pl-menu-lbl">Service</label>
                        <Select value="" onChange={(v) => v && applyItemToAll("service", v)} placeholder="Pick service" options={services.map((s) => ({ value: s.id, label: s.name }))} />
                      </div>
                    </>
                  )}
                </div>
              )}
              {blueprints.length > 0 && (
                <div className="pl-menu-wrap">
                  <button type="button" className={`pls-act ${genOpen ? "is-on" : ""}`} onClick={() => { setGenOpen((v) => !v); setBulkOpen(false); }} title="Add the phases of a blueprint">
                    <Ico d="M13 2L4.5 13H11l-1 9 8.5-11H12z" />Blueprint
                  </button>
                  {genOpen && (
                    <>
                      <div className="pl-menu-layer" onClick={() => setGenOpen(false)} />
                      <div className="pl-menu-pop">
                        <span className="pl-menu-title">Add the phases of</span>
                        {blueprints.map((b) => (
                          <button key={b.id} className="pl-menu-item" onClick={() => { generateFromBlueprint(b.id); setGenOpen(false); }}>{b.name || "Untitled blueprint"}</button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
              <button type="button" className="pls-act" onClick={onDuplicate} disabled={busy} title="Duplicate this pipeline"><Ico d={IC.copy} />Duplicate</button>
            </div>
          </div>
        </div>
        {saveErr && (
          <div className="pl-save-err pls-err" role="alert">
            <span>{saveErr}</span>
            <button type="button" onClick={() => setSaveErr(null)} aria-label="Dismiss">×</button>
          </div>
        )}

        <div className="pls-scroll" onClick={(e) => { if (e.target === e.currentTarget) setSelId(null); }}>
          {!loaded ? <div className="pls-loading"><span /><span /><span /></div> : (
            <div className="pls-canvas">
            <div className={`pls-flow ${dragIdx !== null ? "is-dragging" : ""}`}>
              <div className="pls-cap"><span className="pls-cap-dot" aria-hidden="true" /><b>Start</b></div>
              {steps.map((p, i) => (
                <Fragment key={p.id}>
                  {gap(i)}
                  {step(p, i)}
                </Fragment>
              ))}
              {steps.length > 0 && gap(steps.length)}
              <div className="pls-add">
                <span className="pls-dot is-add" aria-hidden="true"><Ico d={IC.plus} /></span>
                <input value={nextName} onChange={(e) => setNextName(e.target.value)} placeholder={steps.length ? "Add a phase…" : "Name the first phase…"}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addNext(); } }} aria-label="Name of the next phase" />
                <button type="button" onClick={addNext} disabled={!nextName.trim()}>Add</button>
              </div>

              {win || loss ? (
                <div className="pls-fork">
                  <svg className="pls-fork-lines" viewBox="0 0 400 64" preserveAspectRatio="none" aria-hidden="true">
                    <path className="is-win" d="M17 0 C17 34, 100 30, 100 64" />
                    <path className="is-loss" d="M17 0 C17 34, 300 30, 300 64" />
                  </svg>
                  <div className="pls-fork-label">
                    <button type="button" onClick={removeEnding} title="Take the Won / Lost ending away" aria-label="Remove the Won / Lost ending"><Ico d="M6 6l12 12M18 6L6 18" /></button>
                  </div>
                  <div className="pls-fork-outs">
                    {outcome(win, "win")}
                    {outcome(loss, "loss")}
                  </div>
                </div>
              ) : (
                <button type="button" className="pls-fork-add" onClick={() => addEnding()}>
                  <span className="pls-fork-add-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3v6a6 6 0 0 0 6 6h0a6 6 0 0 1 6 6M6 9a6 6 0 0 0 6 6M18 3v6" /></svg></span>
                  <span><b>End it with Won / Lost</b><em>One step that splits in two — the deals tracker shows both.</em></span>
                </button>
              )}
            </div>
            </div>
          )}
        </div>
      </section>

      <div className={`pls-side ${sel ? "is-open" : ""}`} style={sel ? { ["--c" as string]: sel.sales_outcome === "win" ? "#12b57f" : sel.sales_outcome === "loss" ? "#d64545" : tone(sel) } : undefined}>
        {sel && (
          <PhasePanel
            key={sel.id}
            phase={sel}
            focusName={fresh === sel.id}
            depts={depts}
            products={products}
            services={services}
            pipelines={others}
            isSales={isSales}
            onClose={() => setSelId(null)}
            onDelete={() => removePhase(sel.id)}
            onChange={(patch) => setPhases((ps) => ps.map((p) => (p.id === sel.id ? { ...p, ...patch } : p)))}
          />
        )}
      </div>

      {ask > 0 && (
        <LeaveAsk
          step={ask as 1 | 2}
          count={diff.count}
          summary={summarize(diff)}
          saving={saving}
          onKeep={() => { leaveTo.current = null; setAsk(0); }}
          onSave={async () => { if (await save()) leaveNow(); else { leaveTo.current = null; setAsk(0); } }}
          onDiscard={() => setAsk(2)}
          onBack={() => setAsk(1)}
          onConfirmDiscard={() => { setDraft(base); dirtyRef.current = false; leaveNow(); }}
        />
      )}
    </>
  );
}

/** "2 phases added · 1 moved or edited · 3 connections changed · name" */
function summarize(d: ReturnType<typeof diffDraft>): string[] {
  const out: string[] = [];
  const n = (k: number, one: string, many: string) => (k ? `${k} ${k === 1 ? one : many}` : "");
  if (d.pipe.name !== undefined) out.push("Pipeline name");
  if (d.pipe.folder_id !== undefined) out.push("Folder");
  if (d.pipe.is_sales !== undefined) out.push("Sales pipeline on / off");
  out.push(n(d.added.length, "phase added", "phases added"));
  out.push(n(d.removed.length, "phase deleted", "phases deleted"));
  const edited = new Set([...d.changed.map((c) => c.id), ...d.depts, ...d.items].filter((id) => !d.added.some((p) => p.id === id)));
  out.push(n(edited.size, "phase moved or edited", "phases moved or edited"));
  if (d.addLinks.length + d.delLinks.length) out.push("Order of the phases");
  return out.filter(Boolean);
}

// ============================ Leaving with unsaved changes: two steps ============================
function LeaveAsk({ step, count, summary, saving, onKeep, onSave, onDiscard, onBack, onConfirmDiscard }: {
  step: 1 | 2; count: number; summary: string[]; saving: boolean;
  onKeep: () => void; onSave: () => void; onDiscard: () => void; onBack: () => void; onConfirmDiscard: () => void;
}) {
  // Esc: step 2 → step 1 → keep editing. Never reaches the editor behind.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      if (saving) return;
      if (step === 2) onBack(); else onKeep();
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [step, saving, onBack, onKeep]);
  const many = `${count} unsaved change${count === 1 ? "" : "s"}`;
  return createPortal(
    <div className="pl-del-backdrop pl-ask-backdrop" onMouseDown={() => { if (!saving) (step === 2 ? onBack() : onKeep()); }}>
      <div className={`pl-del pl-ask ${step === 2 ? "is-step2" : ""}`} onMouseDown={(e) => e.stopPropagation()} role="alertdialog" aria-modal="true" aria-labelledby="pl-ask-title">
        <div className="pl-del-steps" aria-hidden="true"><i className="is-on" /><i className={step === 2 ? "is-on" : ""} /></div>
        <span className={`pl-del-ico ${step === 1 ? "is-save" : ""}`}>
          {step === 1
            ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M7 3v5h8V3M7 21v-7h10v7" /></svg>
            : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>}
        </span>
        <span className={`pl-del-eyebrow ${step === 1 ? "is-save" : ""}`}>{step === 1 ? "Leaving the editor · step 1 of 2" : "Discard · step 2 of 2"}</span>
        <h2 id="pl-ask-title" className="pl-del-title">{step === 1 ? <>You have {many}</> : <>Discard {many}?</>}</h2>
        {step === 1 ? (
          <>
            <p className="pl-del-sub">Save them before leaving, or discard them.</p>
            {summary.length > 0 && <ul className="pl-del-list pl-ask-list">{summary.map((s) => <li key={s}>{s}</li>)}</ul>}
            <div className="pl-del-actions pl-ask-actions">
              <button className="pl-del-cancel" onClick={onKeep} disabled={saving}>Keep editing</button>
              <button className="pl-del-next" onClick={onDiscard} disabled={saving}>Discard…</button>
              <button className="pl-ask-save" onClick={onSave} disabled={saving} autoFocus>{saving ? "Saving…" : "Save and leave"}</button>
            </div>
          </>
        ) : (
          <>
            <p className="pl-del-sub">Everything you changed since the last save is lost. This can't be undone.</p>
            <div className="pl-del-actions">
              <button className="pl-del-cancel" onClick={onBack} autoFocus>Back</button>
              <button className="pl-del-go" onClick={onConfirmDiscard}>Discard and leave</button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ============================ Phase panel ============================
// Changes go to the editor's draft; Save writes them.
function PhasePanel({ phase, focusName, depts, products, services, pipelines, isSales, onClose, onDelete, onChange }: {
  phase: Phase;
  /** A step just added: its name is ready to type over. */
  focusName?: boolean;
  depts: { key: string; label: string; color: string }[];
  products: { id: string; name: string }[];
  services: { id: string; name: string }[];
  pipelines: Pipeline[];
  isSales: boolean;
  onClose: () => void; onDelete: () => void;
  onChange: (patch: Partial<Phase>) => void;
}) {
  const toggleDept = (key: string) =>
    onChange({ deptKeys: phase.deptKeys.includes(key) ? phase.deptKeys.filter((k) => k !== key) : [...phase.deptKeys, key] });
  const addItem = (type: "product" | "service", id: string) => {
    if (phase.items.some((i) => i.type === type && i.id === id)) return;
    onChange({ items: [...phase.items, { type, id }] });
  };
  const removeItem = (type: "product" | "service", id: string) =>
    onChange({ items: phase.items.filter((i) => !(i.type === type && i.id === id)) });
  const itemName = (type: "product" | "service", id: string) =>
    (type === "product" ? products : services).find((x) => x.id === id)?.name ?? "—";

  return (
    <aside className="pl-panel">
      <div className="pl-panel-head">
        <span className={`pl-eyebrow ${phase.sales_outcome ? `is-${phase.sales_outcome}` : ""}`}>{phase.sales_outcome === "win" ? "End · Won" : phase.sales_outcome === "loss" ? "End · Lost" : "Phase"}</span>
        <button className="pl-x" onClick={onClose} aria-label="Close phase">×</button>
      </div>

      <div className="pl-field">
        <label>Phase name</label>
        <input value={phase.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="e.g. Onboarding"
          autoFocus={focusName} onFocus={(e) => { if (focusName) e.currentTarget.select(); }} />
      </div>

      <span className="pl-section">Departments</span>
      <div className="pl-dept-grid">
        {depts.map((d) => (
          <button key={d.key}
            className={`pl-dept-chip ${phase.deptKeys.includes(d.key) ? "on" : ""}`}
            style={phase.deptKeys.includes(d.key) ? { borderColor: d.color, background: `${d.color}18` } : undefined}
            onClick={() => toggleDept(d.key)}>
            <span className="pl-dept-swatch" style={{ background: d.color }}><DeptIcon k={d.key} /></span>
            {d.label}
          </button>
        ))}
      </div>

      <span className="pl-section">Products &amp; services</span>
      <div className="pl-items">
        {phase.items.length === 0 && <p className="pl-hint">None attached yet.</p>}
        {phase.items.map((it) => (
          <span key={`${it.type}:${it.id}`} className={`pl-item ${it.type}`}>
            <span className="pl-item-ico">
              {it.type === "product" ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 7l9-4 9 4-9 4-9-4z" /><path d="M3 7v10l9 4 9-4V7" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              )}
            </span>
            {itemName(it.type, it.id)}
            <button onClick={() => removeItem(it.type, it.id)} aria-label="Remove">×</button>
          </span>
        ))}
      </div>
      <Select value="" onChange={(v) => v && addItem("product", v)} placeholder="+ Add product"
        options={products.map((p) => ({ value: p.id, label: p.name }))} />
      <div style={{ height: 8 }} />
      <Select value="" onChange={(v) => v && addItem("service", v)} placeholder="+ Add service"
        options={services.map((s) => ({ value: s.id, label: s.name }))} />

      {isSales && (
        <>
          <span className="pl-section">Sales panel</span>
          <button
            type="button" role="switch" aria-checked={phase.sales_visible !== false}
            className={`pl-sales-row ${phase.sales_visible !== false ? "on" : ""}`}
            onClick={() => onChange({ sales_visible: !(phase.sales_visible !== false) })}
          >
            <span className="pl-sales-txt">Show this phase in sales tracking</span>
            <span className="pl-sales-sw"><span className="pl-sales-knob" /></span>
          </button>
          {phase.sales_outcome && <span className="pl-outcome-hint">Reaching this end marks the deal as <b>{phase.sales_outcome === "win" ? "won" : "lost"}</b>.</span>}

          {/* Close probability — the % chance a deal in this phase will close.
              Win phases are 100% and Loss 0% by definition, so the field only
              applies to normal phases. */}
          {!phase.sales_outcome ? (
            <>
              <span className="pl-outcome-label">Close probability</span>
              <div className="pl-prob">
                <input
                  className="pl-prob-input"
                  type="number" min={0} max={100} step={5}
                  value={phase.close_probability ?? ""}
                  placeholder="—"
                  onChange={(e) => {
                    const raw = e.target.value;
                    onChange({ close_probability: raw === "" ? null : Math.max(0, Math.min(100, Math.round(Number(raw)))) });
                  }}
                />
                <span className="pl-prob-pct">%</span>
                <div className="pl-prob-track">
                  <span className="pl-prob-fill" style={{ width: `${phase.close_probability ?? 0}%` }} />
                </div>
              </div>
              <span className="pl-hint" style={{ marginTop: 4 }}>Chance a deal in this phase will close. Used to weight the sales forecast.</span>
            </>
          ) : (
            <span className="pl-hint" style={{ marginTop: 6 }}>
              {phase.sales_outcome === "win" ? "Won phases count as 100% closed." : "Lost phases count as 0%."}
            </span>
          )}
        </>
      )}

      <span className="pl-section">Handover</span>
      <Select
        value={phase.handover_to ?? ""}
        onChange={(v) => onChange({ handover_to: v || null })}
        placeholder="— No handover —"
        options={[{ value: "", label: "— No handover —" }, ...pipelines.map((p) => ({ value: p.id, label: `→ ${p.name}` }))]}
      />
      <span className="pl-hint" style={{ marginTop: 6 }}>When this phase ends, hand the client over to another pipeline.</span>

      <button className="pl-delete" onClick={onDelete}>Delete phase</button>
    </aside>
  );
}
