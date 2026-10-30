/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../api/supabase";
import Select from "../../framework/Select";
import { useBackToClose } from "../../framework/useBackToClose";
import { setLeaveGuard, loadDepartments, deptName, deptInfo, DEFAULT_DEPARTMENTS } from "../../framework/pageAccess";
import {
  listPipelines, createPipeline, savePipelineOrder, pipelineUsage, deletePipelineSafely, renewalPipelineOf, setRenewalPipeline,
  loadPipeline, loadPhasesByPipeline, syncPipelineToBlueprint,
  listFolders, createFolder, renameFolder, moveFolder, deleteFolder, setPipelineFolder, duplicatePipeline,
  diffDraft, savePipelineDraft,
  type Pipeline, type PipelineFolder, type PipelineDraft, type Phase, type PipelineLink, type PipelineUsage,
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

const NODE_W = 200;
const NODE_H = 92;
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

/** A pipeline's phases in order as one slim bar: a segment each, Win green, Loss red. */
function PhaseBar({ phases }: { phases: Phase[] }) {
  if (!phases.length) return <span className="plv-bar is-empty" aria-label="No phases yet" />;
  return (
    <span className="plv-bar" role="img" aria-label={`${phases.length} phases: ${phases.map((p) => p.name).join(", ")}`}>
      {phases.map((p) => <i key={p.id} className={p.sales_outcome === "win" ? "is-win" : p.sales_outcome === "loss" ? "is-loss" : ""} title={p.name} />)}
    </span>
  );
}

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
  const [openId, setOpenId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
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

  if (openId) {
    const pipe = pipelines.find((p) => p.id === openId);
    if (pipe) return <PipelineEditor pipeline={pipe} folders={folders} onBack={() => { setOpenId(null); refresh(); }} onSaved={refresh} />;
  }

  const clickRow = (id: string) => {
    if (previewId === id) setOpenId(id);   // second click on the previewed one → editor
    else setPreviewId(id);                  // first click → preview
  };
  const newBlank = async (folderId: string | null) => {
    setPop(null);
    let p = await createPipeline("Untitled pipeline", folderId);
    if (!p && folderId) p = await createPipeline("Untitled pipeline");
    if (!p) { setMsg("Couldn't create the pipeline: your user isn't allowed to."); return; }
    await refresh(); setOpenId(p.id);
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
    await refresh(); setOpenId(r.id);
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

  const pipeRow = (p: Pipeline) => {
    const ph = phasesBy[p.id] ?? [];
    const isOver = over?.kind === "pipe" && over.id === p.id && drag?.id !== p.id;
    return (
      <div
        key={p.id}
        className={`plv-row ${previewId === p.id ? "is-active" : ""} ${drag?.id === p.id ? "is-dragging" : ""} ${isOver ? (over!.kind === "pipe" && over!.after ? "is-after" : "is-before") : ""}`}
        onClick={() => clickRow(p.id)}
        onDoubleClick={() => setOpenId(p.id)}
        onKeyDown={(e) => { if (e.key === "Enter") setOpenId(p.id); else if (e.key === " ") { e.preventDefault(); setPreviewId(p.id); } }}
        tabIndex={0} role="treeitem" aria-selected={previewId === p.id}
        draggable
        onDragStart={(e) => startDrag(e, { kind: "pipe", id: p.id })}
        onDragEnd={endDrag}
        {...dropTarget({ kind: "pipe", id: p.id, after: false })}
      >
        <span className="plv-row-main">
          <span className="plv-row-top">
            <span className="plv-row-name">{p.name || "Untitled pipeline"}</span>
            {p.is_sales && <span className="plv-tag" title="Shown in Sales">Sales</span>}
            <span className="plv-row-n">{ph.length || "—"}</span>
          </span>
          <PhaseBar phases={ph} />
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
  const previewPhases = preview ? phasesBy[preview.id] ?? [] : [];
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
        <MenuItem icon={IC.blank} label="Blank pipeline" hint="Start from an empty canvas" onClick={() => newBlank(pop.folder)} />
        {pipelines.length > 0 && (
          <>
            <div className="plv-pop-sep" />
            <span className="plv-pop-k">Start from a copy of</span>
            <div className="plv-pop-search"><Ico d={IC.search} /><input value={copyQ} onChange={(e) => setCopyQ(e.target.value)} placeholder="Find a pipeline" aria-label="Find a pipeline to copy" /></div>
            <div className="plv-pop-list">
              {copyChoices.map((p) => (
                <MenuItem key={p.id} icon={IC.copy} label={p.name || "Untitled pipeline"}
                  hint={[folderOf(p) ? tree.path(folderOf(p)) : null, `${(phasesBy[p.id] ?? []).length} phases`].filter(Boolean).join(" · ")}
                  onClick={() => newCopy(p, pop.folder ?? undefined)} />
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
        <MenuItem icon={IC.edit} label="Edit pipeline" onClick={() => { setPop(null); setOpenId(p.id); }} />
        <MenuItem icon={IC.copy} label="Duplicate" hint="Same phases, under a new name" onClick={() => newCopy(p)} />
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

  return (
    <div className="pl plv">
      <header className="plv-head">
        <button className="pl-back" onClick={onBack} aria-label="Back">‹</button>
        <div className="plv-titles">
          <h1 className="pl-title">Client pipelines</h1>
          <p>{loaded ? `${pipelines.length} ${pipelines.length === 1 ? "pipeline" : "pipelines"}${nFolders ? ` in ${nFolders} ${nFolders === 1 ? "folder" : "folders"}` : ""} · the same order for everyone` : "Loading…"}</p>
        </div>
      </header>

      <div className="plv-body">
        <aside className="plv-side" aria-label="Pipelines">
          <div className="plv-acts">
            <button type="button" className={`plv-new ${pop?.kind === "new" && !pop.folder ? "is-open" : ""}`} disabled={busy}
              onClick={(e) => openPop(e, { kind: "new", rect: e.currentTarget.getBoundingClientRect(), folder: null })} aria-haspopup="menu">
              <Ico d={IC.plus} />{busy ? "Copying…" : "New pipeline"}
            </button>
            {folders !== null && (
              <button type="button" className="plv-newf" onClick={() => newFolder(null)} title="New folder"><Ico d={IC.folderPlus} />Folder</button>
            )}
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

        <section className="plv-main" aria-label="Preview">
          {preview ? (
            <>
              <div className="plv-pv-head">
                <div className="plv-pv-title">
                  <h2>{preview.name || "Untitled pipeline"}</h2>
                  <div className="plv-pv-meta">
                    <span><FolderIco />{folderOf(preview) ? tree.path(folderOf(preview)) : "Not in a folder"}</span>
                    <span>{previewPhases.length} {previewPhases.length === 1 ? "phase" : "phases"}</span>
                    {preview.is_sales && <span className="plv-tag">Shown in Sales</span>}
                    {renewalPipelineOf(pipelines)?.id === preview.id && <span className="plv-tag is-renew">Renewals come here</span>}
                  </div>
                </div>
                {(() => {
                  const on = renewalPipelineOf(pipelines)?.id === preview.id;
                  return (
                    <button type="button" className={`plv-btn-ghost plv-renew ${on ? "is-on" : ""}`} disabled={busy}
                      title={on ? "Ended client contracts come back to Sales in this pipeline, as renewal deals. Press to stop." : "Send ended client contracts here, as renewal deals"}
                      onClick={async () => { const e = await setRenewalPipeline(on ? null : preview.id); setMsg(e); await refresh(); }}>
                      <Ico d={on ? IC.check : IC.renew} />{on ? "Renewal pipeline" : "Use for renewals"}
                    </button>
                  );
                })()}
                <button type="button" className="plv-btn-ghost" onClick={() => newCopy(preview)} disabled={busy}><Ico d={IC.copy} />Duplicate</button>
                <button type="button" className="plv-btn" onClick={() => setOpenId(preview.id)}><Ico d={IC.edit} />Edit pipeline</button>
              </div>
              <div className="plv-canvas">
                <PipelinePreview key={preview.id} pipelineId={preview.id} onOpen={() => setOpenId(preview.id)} />
              </div>
            </>
          ) : (
            <div className="plv-pv-empty">{loaded ? "Pick a pipeline on the left to see its phases." : ""}</div>
          )}
        </section>
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

// ============================ Read-only quick view (pan + zoom) ============================
function PipelinePreview({ pipelineId, onOpen }: { pipelineId: string; onOpen: () => void }) {
  const [phases, setPhases] = useState<Phase[]>([]);
  const [links, setLinks] = useState<PipelineLink[]>([]);
  const [viewX, setViewX] = useState(30);
  const [viewY, setViewY] = useState(30);
  const [zoom, setZoom] = useState(0.75);
  const ref = useRef<HTMLDivElement>(null);
  const pan = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);

  useEffect(() => {
    loadPipeline(pipelineId).then(({ phases, links }) => {
      setPhases(phases); setLinks(links);
      // the whole pipeline in view: zoom to fit the pane, centred
      if (phases.length) {
        const minX = Math.min(...phases.map((p) => p.pos_x)), maxX = Math.max(...phases.map((p) => p.pos_x)) + NODE_W;
        const minY = Math.min(...phases.map((p) => p.pos_y)), maxY = Math.max(...phases.map((p) => p.pos_y)) + NODE_H;
        const box = ref.current?.getBoundingClientRect();
        const w = box?.width || 800, h = box?.height || 500, pad = 48;
        const z = Math.max(0.3, Math.min(1, (w - pad * 2) / (maxX - minX), (h - pad * 2) / (maxY - minY)));
        setZoom(z);
        setViewX((w - (maxX - minX) * z) / 2 - minX * z);
        setViewY(Math.min(pad, (h - (maxY - minY) * z) / 2) - minY * z);
      }
    }).catch(() => {});
  }, [pipelineId]);

  useEffect(() => {
    const el = ref.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => Math.min(1.6, Math.max(0.3, z * (e.deltaY < 0 ? 1.1 : 0.9))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const center = (p: Phase) => ({ x: p.pos_x + NODE_W / 2, y: p.pos_y + NODE_H / 2 });

  return (
    <div
      className="pl-qv"
      ref={ref}
      onPointerDown={(e) => { pan.current = { sx: e.clientX, sy: e.clientY, vx: viewX, vy: viewY }; ref.current?.setPointerCapture(e.pointerId); }}
      onPointerMove={(e) => { if (pan.current) { setViewX(pan.current.vx + (e.clientX - pan.current.sx)); setViewY(pan.current.vy + (e.clientY - pan.current.sy)); } }}
      onPointerUp={() => { pan.current = null; }}
      onDoubleClick={onOpen}
    >
      <div className="pl-qv-world" style={{ transform: `translate(${viewX}px, ${viewY}px) scale(${zoom})` }}>
        <svg className="pl-lines">
          <defs>
            <marker id="pl-qv-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0L10 5L0 10z" fill="rgba(134,239,192,0.8)" />
            </marker>
          </defs>
          {links.map((l) => {
            const a = phases.find((p) => p.id === l.from_phase);
            const b = phases.find((p) => p.id === l.to_phase);
            if (!a || !b) return null;
            const ca = center(a), cb = center(b);
            return <line key={l.id} x1={ca.x} y1={ca.y} x2={cb.x} y2={cb.y} className="pl-link-line" markerEnd="url(#pl-qv-arrow)" />;
          })}
        </svg>
        {phases.map((p) => (
          <div key={p.id} className="pl-node pl-node-ro"
            style={{ left: p.pos_x, top: p.pos_y, width: NODE_W, minHeight: NODE_H, ...(p.deptKeys[0] ? { borderColor: `${deptColor(p.deptKeys[0])}66` } : {}) }}>
            <div className="pl-node-name">{p.name || "Untitled phase"}</div>
            <div className="pl-node-depts">
              {p.deptKeys.map((k) => (
                <span key={k} className="pl-dept-badge" style={{ background: deptColor(k) }}><DeptIcon k={k} /></span>
              ))}
            </div>
            {p.items.length > 0 && <div className="pl-node-items">{p.items.length} item{p.items.length !== 1 ? "s" : ""}</div>}
          </div>
        ))}
        {phases.length === 0 && <div className="pl-qv-empty">This pipeline has no phases yet.</div>}
      </div>
    </div>
  );
}

// ============================ Editor ============================
// Everything you change stays on screen until Save. Leaving with changes —
// ‹, Esc, the browser's Back, the sidebar, the search, closing the tab — asks
// first: Save and leave / Discard (confirmed a second time) / Keep editing.
function PipelineEditor({ pipeline, folders, onBack, onSaved }: {
  pipeline: Pipeline; folders: PipelineFolder[] | null; onBack: () => void; onSaved: () => void;
}) {
  const navigate = useNavigate();
  const blank: PipelineDraft = {
    name: pipeline.name, isSales: pipeline.is_sales ?? false, folderId: pipeline.folder_id ?? null,
    source: pipeline.source_blueprint_id ?? null, phases: [], links: [],
  };
  const [base, setBase] = useState<PipelineDraft>(blank);     // as in the database
  const [draft, setDraft] = useState<PipelineDraft>(blank);   // as on screen
  const [loaded, setLoaded] = useState(false);
  const phases = draft.phases, links = draft.links, isSales = draft.isSales;
  const setPhases = (fn: (ps: Phase[]) => Phase[]) => setDraft((d) => ({ ...d, phases: fn(d.phases) }));
  const setLinks = (fn: (ls: PipelineLink[]) => PipelineLink[]) => setDraft((d) => ({ ...d, links: fn(d.links) }));
  const diff = useMemo(() => diffDraft(base, draft), [base, draft]);
  const dirty = loaded && diff.count > 0;

  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [savedOnce, setSavedOnce] = useState(false);
  const [ask, setAsk] = useState<0 | 1 | 2>(0);              // 1: unsaved changes · 2: confirm discard
  const leaveTo = useRef<(() => void) | null>(null);

  const [selId, setSelId] = useState<string | null>(null);
  const [selLink, setSelLink] = useState<string | null>(null);
  const [products, setProducts] = useState<{ id: string; name: string }[]>([]);
  const [services, setServices] = useState<{ id: string; name: string }[]>([]);
  const [depts, setDepts] = useState<{ key: string; label: string; color: string }[]>([]);
  const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
  const [allPipelines, setAllPipelines] = useState<Pipeline[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [genOpen, setGenOpen] = useState(false);

  // pan + zoom
  const [viewX, setViewX] = useState(40);
  const [viewY, setViewY] = useState(40);
  const [zoom, setZoom] = useState(1);
  const canvasRef = useRef<HTMLDivElement>(null);
  const pan = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);
  const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean; sx: number; sy: number } | null>(null);
  const linking = useRef<{ from: string } | null>(null);
  const [linkGhost, setLinkGhost] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [, force] = useState(0);
  const nodeRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const livePos = useRef<{ x: number; y: number } | null>(null);

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
    // Load the real departments placed on the org chart, keeping the shared icon/color.
    loadDepartments(true).then((ds) => {
      setDepts((ds.length ? ds.map((d) => ({ key: d.key, label: d.name, color: d.color })) : DEFAULT_DEPARTMENTS.map((d) => ({ key: d.key, label: d.label, color: d.color }))));
    }).catch(() => {});
    loadBlueprintData().then((d) => setBlueprints(d.blueprints)).catch(() => {});
    listPipelines().then((ps) => setAllPipelines(ps.filter((p) => p.id !== pipeline.id))).catch(() => {});
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
  /** Close, or go elsewhere (`go`): asks first when there are unsaved changes. */
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
  // the sidebar, the account menu and the search ask through this
  useEffect(() => {
    setLeaveGuard((go) => { if (!dirtyRef.current) return false; leaveTo.current = go; setAsk(1); return true; });
    return () => setLeaveGuard(null);
  }, []);
  // the browser's Back closes the editor (asks first with changes)
  useBackToClose("pipeline-editor", onBack, true, () => {
    if (!dirtyRef.current) return false;
    leaveTo.current = null; setAsk(1); return true;
  });
  // links anywhere else on the page
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
    // closing or reloading the tab: the browser's own "Leave site?" question
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    document.addEventListener("click", onClick, true);
    window.addEventListener("beforeunload", onUnload);
    return () => { document.removeEventListener("click", onClick, true); window.removeEventListener("beforeunload", onUnload); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  // ---- keyboard: Esc steps back one level (menu → connection → phase → close), ⌘S / Ctrl+S saves ----
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (!ask) void save(); return; }
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    if (e.key === "Escape") {
      if (e.defaultPrevented || ask) return;                       // a dropdown, or the question itself, handles it
      if (typing) { t!.blur(); return; }
      if (bulkOpen || genOpen) { setBulkOpen(false); setGenOpen(false); return; }
      if (linking.current) { linking.current = null; setLinkGhost(null); return; }
      if (selLink) { setSelLink(null); return; }
      if (selId) { setSelId(null); return; }
      requestLeave();
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && selLink && !typing) {
      e.preventDefault(); const id = selLink; setSelLink(null); dropLink(id);
    }
  };
  useEffect(() => {
    const f = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, []);

  const toCanvas = (cx: number, cy: number) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: (cx - r.left - viewX) / zoom, y: (cy - r.top - viewY) / zoom };
  };

  // ---- pan ----
  const onCanvasPointerDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest?.(".pl-node")) return;
    if ((e.target as Element).closest?.("[data-link], .pl-link-del")) return; // a link handles itself
    setSelLink(null);
    if (linking.current) { linking.current = null; setLinkGhost(null); return; }
    pan.current = { sx: e.clientX, sy: e.clientY, vx: viewX, vy: viewY };
    canvasRef.current?.setPointerCapture(e.pointerId);
    setSelId(null);
  };
  const onCanvasPointerMove = (e: React.PointerEvent) => {
    if (linking.current) {
      const from = phases.find((p) => p.id === linking.current!.from);
      if (from) {
        const p = toCanvas(e.clientX, e.clientY);
        setLinkGhost({ x1: from.pos_x + NODE_W / 2, y1: from.pos_y + NODE_H / 2, x2: p.x, y2: p.y });
      }
    }
    if (drag.current) {
      const d = drag.current;
      if (Math.abs(e.clientX - d.sx) > 3 || Math.abs(e.clientY - d.sy) > 3) d.moved = true;
      const p = toCanvas(e.clientX, e.clientY);
      const x = Math.round(p.x - d.dx), y = Math.round(p.y - d.dy);
      livePos.current = { x, y };
      // Move the node directly in the DOM — no React re-render, so it tracks the cursor 1:1.
      const el = nodeRefs.current[d.id];
      if (el) { el.style.left = `${x}px`; el.style.top = `${y}px`; }
      // Update any connected link lines live.
      const cx = x + NODE_W / 2, cy = y + NODE_H / 2;
      links.forEach((l) => {
        if (l.from_phase === d.id) {
          document.querySelectorAll<SVGLineElement>(`[data-link="${l.id}"]`).forEach((ln) => { ln.setAttribute("x1", String(cx)); ln.setAttribute("y1", String(cy)); });
        }
        if (l.to_phase === d.id) {
          document.querySelectorAll<SVGLineElement>(`[data-link="${l.id}"]`).forEach((ln) => { ln.setAttribute("x2", String(cx)); ln.setAttribute("y2", String(cy)); });
        }
      });
    }
    if (pan.current) {
      setViewX(pan.current.vx + (e.clientX - pan.current.sx));
      setViewY(pan.current.vy + (e.clientY - pan.current.sy));
    }
  };
  const onCanvasPointerUp = () => {
    if (drag.current) {
      const d = drag.current;
      if (d.moved && livePos.current) {
        const { x, y } = livePos.current;
        setPhases((ps) => ps.map((ph) => (ph.id === d.id ? { ...ph, pos_x: x, pos_y: y } : ph)));
      } else if (!d.moved) { setSelId(d.id); }
      livePos.current = null;
      drag.current = null;
    }
    pan.current = null;
  };

  // ---- node drag ----
  const onNodePointerDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    if (linking.current) return;
    const ph = phases.find((p) => p.id === id)!;
    const p = toCanvas(e.clientX, e.clientY);
    drag.current = { id, dx: p.x - ph.pos_x, dy: p.y - ph.pos_y, moved: false, sx: e.clientX, sy: e.clientY };
    canvasRef.current?.setPointerCapture(e.pointerId);
    force((n) => n + 1);
  };

  // ---- linking (branch) ----
  const startLink = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    linking.current = { from: id };
    force((n) => n + 1);
  };
  const finishLink = (e: React.PointerEvent, id: string) => {
    if (!linking.current) return;
    e.stopPropagation();
    const from = linking.current.from;
    linking.current = null; setLinkGhost(null);
    if (from === id) return;
    if (links.some((l) => l.from_phase === from && l.to_phase === id)) return;
    setLinks((ls) => [...ls, { id: newId(), from_phase: from, to_phase: id }]);
  };

  // ---- zoom ----
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      setZoom((z) => {
        const nz = Math.min(1.8, Math.max(0.4, z * (e.deltaY < 0 ? 1.1 : 0.9)));
        setViewX((vx) => mx - ((mx - vx) / z) * nz);
        setViewY((vy) => my - ((my - vy) / z) * nz);
        return nz;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const blankPhase = (x: number, y: number, name = "New phase", source: string | null = null): Phase => ({
    id: newId(), pipeline_id: pipeline.id, name, pos_x: Math.round(x), pos_y: Math.round(y), color: null,
    handover_to: null, source_phase_key: source, sales_visible: true, sales_outcome: null, close_probability: null,
    deptKeys: [], items: [],
  });
  const addPhaseAt = () => {
    // drop near the center of the current view
    const r = canvasRef.current!.getBoundingClientRect();
    const cx = (r.width / 2 - viewX) / zoom, cy = (r.height / 2 - viewY) / zoom;
    const ph = blankPhase(cx - NODE_W / 2, cy - NODE_H / 2);
    setPhases((p) => [...p, ph]); setSelId(ph.id);
  };
  const removePhase = (id: string) => {
    setDraft((d) => ({ ...d, phases: d.phases.filter((x) => x.id !== id), links: d.links.filter((l) => l.from_phase !== id && l.to_phase !== id) }));
    if (selId === id) setSelId(null);
  };

  // Generate phases from a blueprint: one node per phase, in a row, linked in sequence.
  const generateFromBlueprint = (bpId: string) => {
    const bp = blueprints.find((b) => b.id === bpId);
    if (!bp || !bp.phases.length) return;
    const baseX = 60, baseY = 120, gap = NODE_W + 80;
    const created = bp.phases.map((p, i) => blankPhase(baseX + i * gap, baseY, p.name || `Phase ${i + 1}`, p.id));
    const newLinks = created.slice(0, -1).map((p, i) => ({ id: newId(), from_phase: p.id, to_phase: created[i + 1].id }));
    setDraft((d) => ({ ...d, source: bpId, phases: [...d.phases, ...created], links: [...d.links, ...newLinks] }));
  };
  const dropLink = (id: string) => setLinks((ls) => ls.filter((l) => l.id !== id));

  // Apply a department / item to every phase at once.
  const applyDeptToAll = (key: string) =>
    setPhases((ps) => ps.map((ph) => ph.deptKeys.includes(key) ? ph : { ...ph, deptKeys: [...ph.deptKeys, key] }));
  const applyItemToAll = (type: "product" | "service", id: string) =>
    setPhases((ps) => ps.map((ph) => ph.items.some((i) => i.type === type && i.id === id) ? ph : { ...ph, items: [...ph.items, { type, id }] }));

  const sel = selId ? phases.find((p) => p.id === selId) ?? null : null;

  const center = (p: Phase) => ({ x: p.pos_x + NODE_W / 2, y: p.pos_y + NODE_H / 2 });
  const lineFor = (l: PipelineLink) => {
    const a = phases.find((p) => p.id === l.from_phase);
    const b = phases.find((p) => p.id === l.to_phase);
    if (!a || !b) return null;
    const ca = center(a), cb = center(b);
    return { id: l.id, x1: ca.x, y1: ca.y, x2: cb.x, y2: cb.y };
  };

  const tree = folderTree(folders ?? []);
  const folderOptions = [{ value: "", label: "No folder" }, ...tree.flat().map(({ f, depth }) => ({ value: f.id, label: `${" ".repeat(depth)}${f.name || "Folder"}` }))];
  const stateText = saving ? "Saving…" : saveErr ? "Not saved" : dirty ? `${diff.count} unsaved change${diff.count === 1 ? "" : "s"}` : savedOnce ? "All changes saved" : "No changes";

  return (
    <div className={`pl-editor ${sel ? "is-wide" : ""}`}>
      <header className="pl-ed-head">
        <button className="pl-back" onClick={() => requestLeave()} aria-label="Back" title={dirty ? "Back (asks about your unsaved changes)" : "Back"}>‹</button>
        <input className="pl-name-input" value={draft.name} onChange={(e) => { const v = e.target.value; setDraft((d) => ({ ...d, name: v })); }} aria-label="Pipeline name" />
        {folders !== null && folders.length > 0 && (
          <div className="pl-ed-folder" title="Folder">
            <FolderIco />
            <Select size="sm" value={tree.has(draft.folderId) ? draft.folderId! : ""} onChange={(v) => setDraft((d) => ({ ...d, folderId: v || null }))}
              options={folderOptions} aria-label="Folder" />
          </div>
        )}
        <button
          className={`pl-sales-toggle ${isSales ? "on" : ""}`}
          onClick={() => setDraft((d) => ({ ...d, isSales: !d.isSales }))}
          title="Show this pipeline in the Sales tracking panel"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><path d="M7 14l3-3 3 2 5-6" /></svg>
          Sales pipeline
        </button>
        <div className="pl-ed-actions">
          {phases.length > 0 && (
            <div className="pl-menu-wrap">
              <button className="pl-btn-ghost" onClick={() => { setBulkOpen((v) => !v); setGenOpen(false); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
                Apply to all
              </button>
              {bulkOpen && (
                <>
                  <div className="pl-menu-layer" onClick={() => setBulkOpen(false)} />
                  <div className="pl-menu-pop">
                    <span className="pl-menu-title">Add to every phase</span>
                    <label className="pl-menu-lbl">Department</label>
                    <Select value="" onChange={(v) => v && applyDeptToAll(v)} placeholder="Pick department"
                      options={depts.map((d) => ({ value: d.key, label: d.label }))} />
                    <label className="pl-menu-lbl">Product</label>
                    <Select value="" onChange={(v) => v && applyItemToAll("product", v)} placeholder="Pick product"
                      options={products.map((p) => ({ value: p.id, label: p.name }))} />
                    <label className="pl-menu-lbl">Service</label>
                    <Select value="" onChange={(v) => v && applyItemToAll("service", v)} placeholder="Pick service"
                      options={services.map((s) => ({ value: s.id, label: s.name }))} />
                  </div>
                </>
              )}
            </div>
          )}
          {blueprints.length > 0 && (
            <div className="pl-menu-wrap">
              <button className="pl-btn-ghost" onClick={() => { setGenOpen((v) => !v); setBulkOpen(false); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L4.5 13H11l-1 9 8.5-11H12z" /></svg>
                From blueprint
              </button>
              {genOpen && (
                <>
                  <div className="pl-menu-layer" onClick={() => setGenOpen(false)} />
                  <div className="pl-menu-pop">
                    <span className="pl-menu-title">Generate phases from</span>
                    {blueprints.map((b) => (
                      <button key={b.id} className="pl-menu-item" onClick={() => { generateFromBlueprint(b.id); setGenOpen(false); }}>
                        {b.name || "Untitled blueprint"}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          <button className="pl-btn-ghost" onClick={addPhaseAt}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
            Add phase
          </button>
          <div className="pl-save-wrap">
            <span className={`pl-save-state ${saveErr ? "is-err" : dirty ? "is-dirty" : savedOnce ? "is-ok" : ""}`} aria-live="polite">{stateText}</span>
            <button className="pl-btn-primary pl-save" onClick={() => void save()} disabled={!dirty || saving || !loaded} title="Save (⌘S / Ctrl+S)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M7 3v5h8V3M7 21v-7h10v7" /></svg>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </header>
      {saveErr && (
        <div className="pl-save-err" role="alert">
          <span>{saveErr}</span>
          <button type="button" onClick={() => setSaveErr(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      <div className="pl-body">
        <div
          className="pl-canvas"
          ref={canvasRef}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={onCanvasPointerUp}
        >
          <div className="pl-zoom">
            <button onClick={() => setZoom((z) => Math.min(1.8, z * 1.15))}>+</button>
            <span>{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom((z) => Math.max(0.4, z * 0.87))}>−</button>
            <button onClick={() => { setZoom(1); setViewX(40); setViewY(40); }}>⤢</button>
          </div>

          <div className="pl-world" style={{ transform: `translate(${viewX}px, ${viewY}px) scale(${zoom})` }}>
            <svg className="pl-lines">
              <defs>
                <marker id="pl-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0 0L10 5L0 10z" fill="rgba(134,239,192,0.8)" />
                </marker>
              </defs>
              {links.map((l) => {
                const ln = lineFor(l);
                if (!ln) return null;
                return (
                  <g key={l.id} className={`pl-link ${selLink === l.id ? "is-sel" : ""}`}>
                    <line data-link={l.id} x1={ln.x1} y1={ln.y1} x2={ln.x2} y2={ln.y2} className="pl-link-line" markerEnd="url(#pl-arrow)" />
                    <line data-link={l.id} x1={ln.x1} y1={ln.y1} x2={ln.x2} y2={ln.y2} className="pl-link-hit"
                      onPointerDown={(e) => { e.stopPropagation(); setSelId(null); setSelLink(l.id); }}>
                      <title>Click to select · Delete to remove</title>
                    </line>
                  </g>
                );
              })}
              {linkGhost && <line x1={linkGhost.x1} y1={linkGhost.y1} x2={linkGhost.x2} y2={linkGhost.y2} className="pl-link-ghost" />}
            </svg>

            {(() => {
              const l = selLink ? links.find((x) => x.id === selLink) : null;
              const ln = l ? lineFor(l) : null;
              if (!l || !ln) return null;
              return (
                <button
                  className="pl-link-del"
                  style={{ left: (ln.x1 + ln.x2) / 2, top: (ln.y1 + ln.y2) / 2, transform: `translate(-50%, -50%) scale(${1 / zoom})` }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => { setSelLink(null); dropLink(l.id); }}
                  title="Remove this connection (Delete)"
                  aria-label="Remove connection"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              );
            })()}

            {phases.map((p) => (
              <div
                key={p.id}
                ref={(el) => { nodeRefs.current[p.id] = el; }}
                className={`pl-node ${selId === p.id ? "is-sel" : ""} ${linking.current ? "is-target" : ""}`}
                style={{ left: p.pos_x, top: p.pos_y, width: NODE_W, minHeight: NODE_H, ...(p.deptKeys[0] ? { borderColor: `${deptColor(p.deptKeys[0])}66` } : {}) }}
                onPointerDown={(e) => { setSelLink(null); onNodePointerDown(e, p.id); }}
                onPointerUp={(e) => finishLink(e, p.id)}
              >
                <div className="pl-node-name">{p.name || "Untitled phase"}</div>
                <div className="pl-node-depts">
                  {p.deptKeys.length === 0 ? <span className="pl-node-none">No department</span> :
                    p.deptKeys.map((k) => (
                      <span key={k} className="pl-dept-badge" style={{ background: deptColor(k) }} title={deptLabel(k)}><DeptIcon k={k} /></span>
                    ))}
                </div>
                {p.items.length > 0 && <div className="pl-node-items">{p.items.length} item{p.items.length !== 1 ? "s" : ""}</div>}
                {p.handover_to && (
                  <div className="pl-node-handover">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                    {allPipelines.find((x) => x.id === p.handover_to)?.name ?? "Handover"}
                  </div>
                )}
                {p.sales_outcome && (
                  <div className={`pl-node-oc pl-node-oc-${p.sales_outcome}`}>
                    {p.sales_outcome === "win" ? "★ Win" : "✕ Loss"}
                  </div>
                )}
                {isSales && !p.sales_outcome && p.close_probability != null && (
                  <div className="pl-node-prob">{p.close_probability}%</div>
                )}
                <button className="pl-node-handle" onPointerDown={(e) => startLink(e, p.id)} title="Drag to link">→</button>
              </div>
            ))}
          </div>
        </div>

        <div className={`pl-panel-wrap ${sel ? "open" : ""}`}>
          {sel && (
            <PhasePanel
              key={sel.id}
              phase={sel}
              depts={depts}
              products={products}
              services={services}
              pipelines={allPipelines}
              isSales={isSales}
              onSetOutcome={(outcome) => {
                const targetId = sel.id;
                // Only one win and one loss per pipeline: the previous one holding this outcome goes back to Normal.
                setPhases((ps) => ps.map((p) => {
                  if (p.id === targetId) return { ...p, sales_outcome: outcome };
                  if (outcome && p.sales_outcome === outcome) return { ...p, sales_outcome: null };
                  return p;
                }));
              }}
              onClose={() => setSelId(null)}
              onDelete={() => removePhase(sel.id)}
              onChange={(patch) => setPhases((ps) => ps.map((p) => (p.id === sel.id ? { ...p, ...patch } : p)))}
            />
          )}
        </div>
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
    </div>
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
  out.push(n(d.addLinks.length + d.delLinks.length, "connection changed", "connections changed"));
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
function PhasePanel({ phase, depts, products, services, pipelines, isSales, onSetOutcome, onClose, onDelete, onChange }: {
  phase: Phase;
  depts: { key: string; label: string; color: string }[];
  products: { id: string; name: string }[];
  services: { id: string; name: string }[];
  pipelines: Pipeline[];
  isSales: boolean;
  onSetOutcome: (outcome: "win" | "loss" | null) => void;
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
        <span className="pl-eyebrow">Phase</span>
        <button className="pl-x" onClick={onClose} aria-label="Close phase">×</button>
      </div>

      <div className="pl-field">
        <label>Phase name</label>
        <input value={phase.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="e.g. Onboarding" />
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
          <span className="pl-outcome-label">Outcome when reached</span>
          <div className="pl-outcome">
            <button className={`pl-oc pl-oc-none ${!phase.sales_outcome ? "on" : ""}`} onClick={() => onSetOutcome(null)}>Normal</button>
            <button className={`pl-oc pl-oc-win ${phase.sales_outcome === "win" ? "on" : ""}`} onClick={() => onSetOutcome("win")}>Win</button>
            <button className={`pl-oc pl-oc-loss ${phase.sales_outcome === "loss" ? "on" : ""}`} onClick={() => onSetOutcome("loss")}>Loss</button>
          </div>
          {phase.sales_outcome && <span className="pl-outcome-hint">Reaching this phase marks the tracking as <b>{phase.sales_outcome === "win" ? "won" : "lost"}</b>.</span>}

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
