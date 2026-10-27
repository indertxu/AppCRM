/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { supabase } from "../../api/supabase";
import "./ClientDirectory.css";

interface Folder { id: string; parent_id: string | null; name: string; sort: number; }
interface CFile {
  id: string; folder_id: string | null; storage_path: string;
  name: string; note: string | null; mime: string | null; size_bytes: number | null; created_at: string;
}

interface Props { clientId: string; tenantId: string | null; }

const BUCKET = "client-files";

const prettySize = (b: number | null) => {
  if (!b) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
};
const kindOf = (name: string, mime: string | null): string => {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf" || mime === "application/pdf") return "PDF";
  if (["doc", "docx"].includes(ext)) return "DOC";
  if (["xls", "xlsx", "csv"].includes(ext)) return "XLS";
  if (["ppt", "pptx"].includes(ext)) return "PPT";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "IMG";
  if (["zip", "rar", "7z"].includes(ext)) return "ZIP";
  return ext ? ext.slice(0, 3).toUpperCase() : "•";
};

export default function ClientDirectory({ clientId, tenantId }: Props) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [files, setFiles] = useState<CFile[]>([]);
  const [cwd, setCwd] = useState<string | null>(null);          // current folder id (null = root)
  const [dragOver, setDragOver] = useState(false);
  const [dropFolder, setDropFolder] = useState<string | null>(null); // folder being hovered while dragging a file
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);   // folder or file id
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [draggingFile, setDraggingFile] = useState<string | null>(null); // file id being dragged between folders
  const inputRef = useRef<HTMLInputElement>(null);

  // ---- load ----------------------------------------------------------
  useEffect(() => {
    let alive = true;
    (async () => {
      const [{ data: fd }, { data: fl }] = await Promise.all([
        supabase.from("client_folders").select("*").eq("client_id", clientId).order("sort").order("name"),
        supabase.from("client_files").select("*").eq("client_id", clientId).order("created_at", { ascending: false }),
      ]);
      if (!alive) return;
      setFolders((fd ?? []) as Folder[]);
      setFiles((fl ?? []) as CFile[]);
    })();
    return () => { alive = false; };
  }, [clientId]);

  // ---- derived -------------------------------------------------------
  const childFolders = useMemo(
    () => folders.filter((f) => f.parent_id === cwd).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)),
    [folders, cwd]);
  const folderFiles = useMemo(
    () => files.filter((f) => (f.folder_id ?? null) === cwd),
    [files, cwd]);

  const crumbs = useMemo(() => {
    const out: Folder[] = [];
    let id = cwd;
    while (id) {
      const f = folders.find((x) => x.id === id);
      if (!f) break;
      out.unshift(f);
      id = f.parent_id;
    }
    return out;
  }, [cwd, folders]);

  // count of items inside a folder (recursive) for the folder card subtitle
  const folderCount = (fid: string): number => {
    const directFiles = files.filter((f) => f.folder_id === fid).length;
    const subs = folders.filter((f) => f.parent_id === fid);
    return directFiles + subs.reduce((s, sf) => s + folderCount(sf.id), 0) + subs.length;
  };

  // ---- folder ops ----------------------------------------------------
  const createFolder = async (name: string) => {
    setNewFolder(false);
    const clean = name.trim();
    if (!clean) return;
    const { data, error } = await supabase.from("client_folders")
      .insert({ client_id: clientId, parent_id: cwd, name: clean, sort: childFolders.length })
      .select().single();
    if (error) { setErr(error.message); return; }
    setFolders((xs) => [...xs, data as Folder]);
  };
  const renameFolder = async (id: string, name: string) => {
    setRenaming(null);
    const clean = name.trim();
    if (!clean) return;
    setFolders((xs) => xs.map((f) => f.id === id ? { ...f, name: clean } : f));
    await supabase.from("client_folders").update({ name: clean }).eq("id", id);
  };
  const deleteFolder = async (id: string) => {
    // gather this folder + all descendants, and their files, to remove from storage
    const toDelete = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      folders.forEach((f) => { if (f.parent_id && toDelete.has(f.parent_id) && !toDelete.has(f.id)) { toDelete.add(f.id); grew = true; } });
    }
    const paths = files.filter((f) => f.folder_id && toDelete.has(f.folder_id)).map((f) => f.storage_path);
    if (paths.length) await supabase.storage.from(BUCKET).remove(paths);
    await supabase.from("client_folders").delete().eq("id", id); // cascade removes children + files rows
    setFolders((xs) => xs.filter((f) => !toDelete.has(f.id)));
    setFiles((xs) => xs.filter((f) => !(f.folder_id && toDelete.has(f.folder_id))));
    if (cwd && toDelete.has(cwd)) setCwd(folders.find((f) => f.id === id)?.parent_id ?? null);
  };

  // ---- file ops ------------------------------------------------------
  const upload = async (fileList: FileList | File[]) => {
    const list = Array.from(fileList);
    if (list.length === 0) return;
    if (!tenantId) { setErr("Still loading — try again in a moment."); return; }
    setBusy(true); setErr(null);
    try {
      for (const f of list) {
        const safe = f.name.replace(/[^\w.\-]+/g, "_");
        const path = `${tenantId}/${clientId}/${crypto.randomUUID()}_${safe}`;
        const up = await supabase.storage.from(BUCKET).upload(path, f, { contentType: f.type || undefined });
        if (up.error) { setErr(up.error.message); continue; }
        const { data, error } = await supabase.from("client_files").insert({
          client_id: clientId, folder_id: cwd, storage_path: path,
          name: f.name, mime: f.type || null, size_bytes: f.size,
        }).select().single();
        if (error) { setErr(error.message); continue; }
        setFiles((xs) => [data as CFile, ...xs]);
      }
    } finally { setBusy(false); if (inputRef.current) inputRef.current.value = ""; }
  };
  const moveFile = async (fileId: string, folderId: string | null) => {
    setFiles((xs) => xs.map((f) => f.id === fileId ? { ...f, folder_id: folderId } : f));
    await supabase.from("client_files").update({ folder_id: folderId }).eq("id", fileId);
  };
  const renameFile = async (id: string, name: string) => {
    setRenaming(null);
    const clean = name.trim();
    if (!clean) return;
    setFiles((xs) => xs.map((f) => f.id === id ? { ...f, name: clean } : f));
    await supabase.from("client_files").update({ name: clean }).eq("id", id);
  };
  const saveNote = async (id: string, note: string) => {
    const v = note.trim() || null;
    setFiles((xs) => xs.map((f) => f.id === id ? { ...f, note: v } : f));
    await supabase.from("client_files").update({ note: v }).eq("id", id);
  };
  const download = async (f: CFile) => {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(f.storage_path, 60);
    if (error || !data) { setErr(error?.message ?? "Could not open file."); return; }
    window.open(data.signedUrl, "_blank");
  };
  const deleteFile = async (f: CFile) => {
    setFiles((xs) => xs.filter((x) => x.id !== f.id));
    await supabase.storage.from(BUCKET).remove([f.storage_path]);
    await supabase.from("client_files").delete().eq("id", f.id);
  };

  const empty = childFolders.length === 0 && folderFiles.length === 0;

  return (
    <div className="cdir">
      {/* breadcrumb + actions */}
      <div className="cdir-bar">
        <nav className="cdir-crumbs">
          <button className={`cdir-crumb ${cwd === null ? "is-cur" : ""}`} onClick={() => setCwd(null)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
            Directory
          </button>
          {crumbs.map((c) => (
            <span key={c.id} className="cdir-crumb-wrap">
              <span className="cdir-crumb-sep">›</span>
              <button className={`cdir-crumb ${cwd === c.id ? "is-cur" : ""}`} onClick={() => setCwd(c.id)}>{c.name}</button>
            </span>
          ))}
        </nav>
        <div className="cdir-actions">
          <ApplyTemplateMenu clientId={clientId} parentId={cwd} parentName={cwd ? folders.find((f) => f.id === cwd)?.name ?? null : null} folders={folders}
            onApplied={(all, msg) => { setFolders(all as Folder[]); setNote(msg); window.setTimeout(() => setNote((m) => (m === msg ? null : m)), 5000); }} />
          <button className="cdir-btn" onClick={() => setNewFolder(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /><path d="M12 11v6M9 14h6" /></svg>
            New folder
          </button>
          <button className="cdir-btn cdir-btn-primary" onClick={() => inputRef.current?.click()}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4M8 8l4-4 4 4" /><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>
            Upload
          </button>
          <input ref={inputRef} type="file" multiple hidden onChange={(e) => e.target.files && upload(e.target.files)} />
        </div>
      </div>

      {err && <p className="cdir-err">{err}</p>}
      {note && <p className="cdir-ok">{note}</p>}

      {/* the drop surface for the current folder */}
      <div
        className={`cdir-grid-wrap ${dragOver ? "is-over" : ""} ${busy ? "is-busy" : ""}`}
        onDragOver={(e) => { if (!draggingFile) { e.preventDefault(); setDragOver(true); } }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault(); setDragOver(false);
          if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
        }}
      >
        <div className="cdir-grid">
          {/* new-folder inline card */}
          {newFolder && (
            <div className="cdir-folder is-new">
              <span className="cdir-folder-ico"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8z" /></svg></span>
              <input className="cdir-rename" autoFocus placeholder="Folder name"
                onBlur={(e) => createFolder(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") createFolder((e.target as HTMLInputElement).value);
                  if (e.key === "Escape") setNewFolder(false);
                }} />
            </div>
          )}

          {/* folders */}
          {childFolders.map((f) => (
            <div
              key={f.id}
              className={`cdir-folder ${dropFolder === f.id ? "is-droptarget" : ""}`}
              onDoubleClick={() => setCwd(f.id)}
              onDragOver={(e) => { if (draggingFile) { e.preventDefault(); setDropFolder(f.id); } }}
              onDragLeave={() => setDropFolder((d) => d === f.id ? null : d)}
              onDrop={(e) => {
                if (!draggingFile) return;
                e.preventDefault(); e.stopPropagation();
                moveFile(draggingFile, f.id);
                setDraggingFile(null); setDropFolder(null);
              }}
            >
              <button className="cdir-folder-open" onClick={() => setCwd(f.id)}>
                <span className="cdir-folder-ico"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8z" /></svg></span>
                {renaming === f.id ? (
                  <input className="cdir-rename" autoFocus defaultValue={f.name}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => renameFolder(f.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") renameFolder(f.id, (e.target as HTMLInputElement).value);
                      if (e.key === "Escape") setRenaming(null);
                    }} />
                ) : (
                  <span className="cdir-folder-name">{f.name}</span>
                )}
                <span className="cdir-folder-count">{folderCount(f.id)} item{folderCount(f.id) === 1 ? "" : "s"}</span>
              </button>
              <div className="cdir-folder-menu">
                <button title="Rename" onClick={(e) => { e.stopPropagation(); setRenaming(f.id); }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
                </button>
                <button title="Delete folder" onClick={(e) => { e.stopPropagation(); deleteFolder(f.id); }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
                </button>
              </div>
            </div>
          ))}

          {/* files */}
          {folderFiles.map((f) => (
            <div
              key={f.id}
              className={`cdir-file ${f.note ? "has-note" : ""}`}
              draggable
              onDragStart={() => setDraggingFile(f.id)}
              onDragEnd={() => { setDraggingFile(null); setDropFolder(null); }}
            >
              {f.note && <span className="cdir-note-tip" role="tooltip">{f.note}</span>}
              <span className={`cdir-kind cdir-kind-${kindOf(f.name, f.mime).toLowerCase()}`}>{kindOf(f.name, f.mime)}</span>
              {renaming === f.id ? (
                <input className="cdir-rename" autoFocus defaultValue={f.name}
                  onBlur={(e) => renameFile(f.id, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") renameFile(f.id, (e.target as HTMLInputElement).value);
                    if (e.key === "Escape") setRenaming(null);
                  }} />
              ) : (
                <button className="cdir-file-name" onClick={() => download(f)} title="Download">
                  {f.name}
                  {f.note && <span className="cdir-note-flag"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16v12H7l-3 3z" /></svg></span>}
                </button>
              )}
              <span className="cdir-file-meta">{prettySize(f.size_bytes)}</span>
              <div className="cdir-file-menu">
                <button title="Rename" onClick={() => setRenaming(f.id)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
                </button>
                <button className={f.note ? "has-note" : ""} title={f.note ? "Edit note" : "Add note"} onClick={() => setNoteFor(noteFor === f.id ? null : f.id)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                </button>
                <button className="cdir-del" title="Delete" onClick={() => deleteFile(f)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
                </button>
              </div>
              {noteFor === f.id && (
                <div className="cdir-noteedit">
                  <textarea defaultValue={f.note ?? ""} placeholder="What's in this file? (shown on hover)" autoFocus
                    onBlur={(e) => { saveNote(f.id, e.target.value); setNoteFor(null); }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setNoteFor(null);
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { saveNote(f.id, (e.target as HTMLTextAreaElement).value); setNoteFor(null); }
                    }} />
                </div>
              )}
            </div>
          ))}
        </div>

        {empty && !newFolder && (
          <div className="cdir-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8z" /></svg>
            <p>{cwd === null ? "Build this client's directory" : "This folder is empty"}</p>
            <span>Drop files here, create a folder, or add a standard structure with <b>Templates</b> above.</span>
          </div>
        )}
        {busy && <div className="cdir-uploading">Uploading…</div>}
      </div>
    </div>
  );
}
// ============================ Contract documents ============================
/**
 * Three drop zones on the Contract tab — license contracts, service contracts and
 * proposals. Drop (or pick) any PDF / Word / … file and it is stored for this client.
 * Each zone is a folder of the client's Directory (created the first time it is used),
 * so the same files also show in the Docs tab.
 */
export const CONTRACT_SLOTS = [
  { key: "license", folder: "License contracts", title: "License contracts", hint: "Software licences, subscriptions, renewals", tone: "violet", icon: "M9 12l2 2 4-4M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z" },
  { key: "service", folder: "Service contracts", title: "Service contracts", hint: "Consultancy, implementation, support", tone: "blue", icon: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5" },
  { key: "proposal", folder: "Proposals", title: "Proposals", hint: "Offers and quotes sent", tone: "amber", icon: "M22 2L11 13M22 2l-7 20-4-9-9-4z" },
] as const;
type SlotKey = (typeof CONTRACT_SLOTS)[number]["key"];

const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const DragType = "application/x-contract-file";

export function ContractDocs({ clientId, tenantId, onCount }: { clientId: string; tenantId: string | null; onCount?: (n: number) => void }) {
  const [folderIds, setFolderIds] = useState<Partial<Record<SlotKey, string>>>({});
  const [files, setFiles] = useState<CFile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [over, setOver] = useState<SlotKey | null>(null);
  const [uploading, setUploading] = useState<{ id: string; slot: SlotKey; name: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const inputs = useRef<Partial<Record<SlotKey, HTMLInputElement | null>>>({});

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data: fd } = await supabase.from("client_folders").select("id, name, parent_id").eq("client_id", clientId).is("parent_id", null);
      const ids: Partial<Record<SlotKey, string>> = {};
      CONTRACT_SLOTS.forEach((s) => { const f = (fd ?? []).find((x: any) => String(x.name).trim().toLowerCase() === s.folder.toLowerCase()); if (f) ids[s.key] = f.id; });
      const all = Object.values(ids) as string[];
      const { data: fl } = all.length
        ? await supabase.from("client_files").select("*").eq("client_id", clientId).in("folder_id", all).order("created_at", { ascending: false })
        : { data: [] as any[] };
      if (!alive) return;
      setFolderIds(ids); setFiles((fl ?? []) as CFile[]); setLoaded(true);
    })();
    return () => { alive = false; };
  }, [clientId]);
  useEffect(() => { onCount?.(files.length); }, [files.length, onCount]);

  const slotOf = (f: CFile): SlotKey | null => (CONTRACT_SLOTS.find((s) => folderIds[s.key] === f.folder_id)?.key ?? null);

  /** The slot's folder, created on first use. */
  const ensureFolder = async (slot: SlotKey): Promise<string | null> => {
    if (folderIds[slot]) return folderIds[slot]!;
    const def = CONTRACT_SLOTS.find((s) => s.key === slot)!;
    const { data, error } = await supabase.from("client_folders")
      .insert({ client_id: clientId, parent_id: null, name: def.folder, sort: CONTRACT_SLOTS.indexOf(def) }).select("id").single();
    if (error || !data) { setErr(error?.message ?? "Could not create the folder."); return null; }
    setFolderIds((m) => ({ ...m, [slot]: data.id }));
    return data.id as string;
  };

  const upload = async (slot: SlotKey, list: FileList | File[]) => {
    const arr = Array.from(list);
    if (!arr.length) return;
    if (!tenantId) { setErr("Still loading — try again in a moment."); return; }
    setErr(null);
    const pending = arr.map((f) => ({ id: crypto.randomUUID(), slot, name: f.name }));
    setUploading((u) => [...u, ...pending]);
    const folder = await ensureFolder(slot);
    if (!folder) { setUploading((u) => u.filter((x) => !pending.some((p) => p.id === x.id))); return; }
    await Promise.all(arr.map(async (f, i) => {
      try {
        const safe = f.name.replace(/[^\w.\-]+/g, "_");
        const path = `${tenantId}/${clientId}/${crypto.randomUUID()}_${safe}`;
        const up = await supabase.storage.from(BUCKET).upload(path, f, { contentType: f.type || undefined });
        if (up.error) { setErr(`${f.name}: ${up.error.message}`); return; }
        const { data, error } = await supabase.from("client_files").insert({
          client_id: clientId, folder_id: folder, storage_path: path, name: f.name, mime: f.type || null, size_bytes: f.size,
        }).select().single();
        if (error) { setErr(`${f.name}: ${error.message}`); await supabase.storage.from(BUCKET).remove([path]); return; }
        setFiles((xs) => [data as CFile, ...xs]);
      } finally {
        setUploading((u) => u.filter((x) => x.id !== pending[i].id));
      }
    }));
    const inp = inputs.current[slot];
    if (inp) inp.value = "";
  };

  const move = async (fileId: string, slot: SlotKey) => {
    const f = files.find((x) => x.id === fileId);
    if (!f || slotOf(f) === slot) return;
    const folder = await ensureFolder(slot);
    if (!folder) return;
    setFiles((xs) => xs.map((x) => (x.id === fileId ? { ...x, folder_id: folder } : x)));
    const { error } = await supabase.from("client_files").update({ folder_id: folder }).eq("id", fileId);
    if (error) setErr(error.message);
  };
  const open = async (f: CFile, download = false) => {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(f.storage_path, 120, download ? { download: f.name } : undefined);
    if (error || !data) { setErr(error?.message ?? "Could not open the file."); return; }
    window.open(data.signedUrl, "_blank", "noopener");
  };
  const remove = async (f: CFile) => {
    setConfirmDel(null);
    setFiles((xs) => xs.filter((x) => x.id !== f.id));
    await supabase.storage.from(BUCKET).remove([f.storage_path]);
    await supabase.from("client_files").delete().eq("id", f.id);
  };

  const onDrop = (slot: SlotKey) => (e: DragEvent) => {
    e.preventDefault(); setOver(null);
    const moved = e.dataTransfer.getData(DragType);
    if (moved) { void move(moved, slot); return; }
    if (e.dataTransfer.files?.length) void upload(slot, e.dataTransfer.files);
  };

  return (
    <div className="cd-docs">
      {CONTRACT_SLOTS.map((s, si) => {
        const list = files.filter((f) => folderIds[s.key] && f.folder_id === folderIds[s.key]);
        const busy = uploading.filter((u) => u.slot === s.key);
        return (
          <section key={s.key} className={`cd-slot ${over === s.key ? "is-over" : ""}`} data-tone={s.tone} style={{ ["--i" as string]: si } as CSSProperties}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = e.dataTransfer.types.includes(DragType) ? "move" : "copy"; if (over !== s.key) setOver(s.key); }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null); }}
            onDrop={onDrop(s.key)}>
            <header className="cd-slot-h">
              <span className="cd-slot-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={s.icon} /></svg></span>
              <div><h4>{s.title}</h4><small>{s.hint}</small></div>
              <em>{list.length}</em>
            </header>

            <button type="button" className="cd-drop" onClick={() => inputs.current[s.key]?.click()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4M7 9l5-5 5 5M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>
              <span><b>{over === s.key ? "Drop to add" : "Drop files here"}</b><small>or click to choose · PDF, Word, any file</small></span>
            </button>
            <input ref={(el) => { inputs.current[s.key] = el; }} type="file" multiple hidden onChange={(e) => e.target.files && upload(s.key, e.target.files)} />

            <ul className="cd-files">
              {busy.map((u) => (
                <li key={u.id} className="cd-file is-busy"><span className="cd-kind">…</span><span className="cd-file-t"><b>{u.name}</b><small>Uploading…</small></span><i className="cd-spin" /></li>
              ))}
              {list.map((f, i) => {
                const k = kindOf(f.name, f.mime);
                return (
                  <li key={f.id} className="cd-file" draggable style={{ ["--j" as string]: i } as CSSProperties}
                    onDragStart={(e) => { e.dataTransfer.setData(DragType, f.id); e.dataTransfer.effectAllowed = "move"; }}>
                    <span className={`cd-kind is-${k.toLowerCase()}`}>{k}</span>
                    <button type="button" className="cd-file-t" onClick={() => void open(f)} title={`Open ${f.name}`}>
                      <b>{f.name}</b>
                      <small>{[prettySize(f.size_bytes), fmtDay(f.created_at)].filter(Boolean).join(" · ")}</small>
                    </button>
                    {confirmDel === f.id ? (
                      <span className="cd-confirm">
                        <button type="button" className="is-del" onClick={() => void remove(f)}>Delete</button>
                        <button type="button" onClick={() => setConfirmDel(null)}>Keep</button>
                      </span>
                    ) : (
                      <span className="cd-acts">
                        <button type="button" aria-label="Download" title="Download" onClick={() => void open(f, true)}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v12M7 11l5 5 5-5M4 20h16" /></svg>
                        </button>
                        <button type="button" aria-label="Delete" title="Delete" onClick={() => setConfirmDel(f.id)}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
                        </button>
                      </span>
                    )}
                  </li>
                );
              })}
              {loaded && !list.length && !busy.length && <li className="cd-none">Nothing here yet</li>}
            </ul>
          </section>
        );
      })}
      {err && <p className="cd-err" role="alert">{err}<button type="button" onClick={() => setErr(null)} aria-label="Dismiss">×</button></p>}
    </div>
  );
}

/**
 * Copies files from another bucket (the deal's sales documents) into a
 * client's root folders by name — the contract slots or any directory folder —
 * creating the folder on first use. Returns the new storage path per item key.
 */
export async function copyIntoClientFolders(clientId: string, items: {
  key: string; fromBucket: string; fromPath: string; name: string; mime: string | null; size: number | null; note?: string | null; folder: string;
}[]): Promise<{ done: Record<string, string>; errors: string[] }> {
  const done: Record<string, string> = {};
  const errors: string[] = [];
  if (!items.length) return { done, errors };
  const { data: cl } = await supabase.from("clients").select("tenant_id").eq("id", clientId).maybeSingle();
  const tenantId = (cl as any)?.tenant_id as string | undefined;
  if (!tenantId) return { done, errors: ["Could not resolve the client's workspace."] };
  const { data: roots } = await supabase.from("client_folders").select("id, name").eq("client_id", clientId).is("parent_id", null);
  const ids = new Map<string, string>(((roots ?? []) as any[]).map((f) => [String(f.name).trim().toLowerCase(), f.id as string]));
  let extra = (roots ?? []).length;
  const ensure = async (name: string): Promise<string | null> => {
    const k = name.trim().toLowerCase();
    if (ids.has(k)) return ids.get(k)!;
    const slot = CONTRACT_SLOTS.findIndex((s) => s.folder.toLowerCase() === k);
    const { data, error } = await supabase.from("client_folders")
      .insert({ client_id: clientId, parent_id: null, name: name.trim(), sort: slot >= 0 ? slot : 3 + extra++ }).select("id").single();
    if (error || !data) { errors.push(`${name}: ${error?.message ?? "could not create the folder"}`); return null; }
    ids.set(k, data.id as string);
    return data.id as string;
  };
  for (const it of items) {
    const folder = await ensure(it.folder);
    if (!folder) continue;
    const dl = await supabase.storage.from(it.fromBucket).download(it.fromPath);
    if (dl.error || !dl.data) { errors.push(`${it.name}: ${dl.error?.message ?? "could not read the file"}`); continue; }
    const safe = it.name.replace(/[^\w.\-]+/g, "_");
    const path = `${tenantId}/${clientId}/${crypto.randomUUID()}_${safe}`;
    const up = await supabase.storage.from(BUCKET).upload(path, dl.data, { contentType: it.mime || undefined });
    if (up.error) { errors.push(`${it.name}: ${up.error.message}`); continue; }
    const { error } = await supabase.from("client_files").insert({
      client_id: clientId, folder_id: folder, storage_path: path, name: it.name, mime: it.mime, size_bytes: it.size, note: it.note ?? null,
    });
    if (error) { errors.push(`${it.name}: ${error.message}`); await supabase.storage.from(BUCKET).remove([path]); continue; }
    done[it.key] = path;
  }
  return { done, errors };
}

// ============================ Folder templates ============================
/**
 * Folder templates ("skeletons"): standard folder structures set up once in
 * Settings › Client page and dropped into any client's Directory in one click.
 * Applying one only adds what's missing: a folder with the same name in the
 * same place is reused, nothing is renamed, moved or deleted (69_client_folder_templates.sql).
 */
export interface FolderNode { id: string; name: string; children: FolderNode[] }
export interface FolderTemplate { id: string; name: string; tree: FolderNode[]; is_default: boolean; sort: number }
export const FOLDER_TEMPLATES_SQL = "Run 69_client_folder_templates.sql in Supabase to save folder templates.";
const nodeId = () => Math.random().toString(36).slice(2, 10);
const cleanTree = (xs: any): FolderNode[] => (Array.isArray(xs) ? xs : [])
  .filter((x) => x && typeof x.name === "string")
  .map((x) => ({ id: String(x.id ?? nodeId()), name: x.name, children: cleanTree(x.children) }));
export const countNodes = (xs: FolderNode[]): number => xs.reduce((n, x) => n + 1 + countNodes(x.children), 0);
export async function loadFolderTemplates(): Promise<{ list: FolderTemplate[]; missing: boolean }> {
  const { data, error } = await supabase.from("client_folder_templates").select("*").order("sort").order("name");
  if (error) return { list: [], missing: /client_folder_templates|relation|schema cache/i.test(error.message) };
  return { list: ((data ?? []) as any[]).map((r) => ({ id: r.id, name: r.name ?? "", tree: cleanTree(r.tree), is_default: !!r.is_default, sort: r.sort ?? 0 })), missing: false };
}
/** Adds the template's folders under `parentId` (null = the top), reusing folders that already have the name. */
export async function applyFolderTemplate(clientId: string, tree: FolderNode[], parentId: string | null, existing: { id: string; parent_id: string | null; name: string; sort: number }[]) {
  const all = [...existing];
  let added = 0, reused = 0;
  const norm = (s: string) => s.trim().toLocaleLowerCase();
  const walk = async (nodes: FolderNode[], parent: string | null): Promise<string | null> => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const name = n.name.trim();
      if (!name) continue;
      let f = all.find((x) => (x.parent_id ?? null) === parent && norm(x.name) === norm(name));
      if (f) reused++;
      else {
        const sibs = all.filter((x) => (x.parent_id ?? null) === parent).length;
        const { data, error } = await supabase.from("client_folders").insert({ client_id: clientId, parent_id: parent, name, sort: sibs }).select("*").single();
        if (error || !data) return error?.message ?? "A folder could not be created.";
        f = data as any;
        all.push(f!); added++;
      }
      if (n.children.length) { const e = await walk(n.children, f!.id); if (e) return e; }
    }
    return null;
  };
  const error = await walk(tree, parentId);
  return { added, reused, error, folders: all };
}
const EXAMPLE_TREE = (): FolderNode[] => [
  { id: nodeId(), name: "01 Contract", children: [{ id: nodeId(), name: "Signed", children: [] }, { id: nodeId(), name: "Amendments", children: [] }] },
  { id: nodeId(), name: "02 Proposals", children: [] },
  { id: nodeId(), name: "03 Project", children: [{ id: nodeId(), name: "Kick-off", children: [] }, { id: nodeId(), name: "Meetings", children: [] }, { id: nodeId(), name: "Deliverables", children: [] }] },
  { id: nodeId(), name: "04 Data & access", children: [] },
  { id: nodeId(), name: "05 Billing", children: [{ id: nodeId(), name: "Invoices", children: [] }] },
];
const FolderGlyph = () => <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8z" /></svg>;
const Ic = ({ d }: { d: string }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;

/** Settings › Client page › Folder templates. */
export function FolderTemplatesEditor({ canEdit = true }: { canEdit?: boolean }) {
  const [list, setList] = useState<FolderTemplate[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [askDel, setAskDel] = useState(false);
  const dirty = useRef<Set<string>>(new Set());
  useEffect(() => { loadFolderTemplates().then((r) => { setList(r.list); setMissing(r.missing); setOpenId(r.list[0]?.id ?? null); }); }, []);
  const cur = (list ?? []).find((t) => t.id === openId) ?? null;
  // each change is saved a moment later
  useEffect(() => {
    if (!list || !dirty.current.size) return;
    const t = window.setTimeout(async () => {
      const ids = [...dirty.current]; dirty.current.clear();
      setState("saving");
      for (const id of ids) {
        const tpl = list.find((x) => x.id === id);
        if (!tpl) continue;
        const { error } = await supabase.from("client_folder_templates").update({ name: tpl.name.trim() || "Untitled", tree: tpl.tree, is_default: tpl.is_default, updated_at: new Date().toISOString() }).eq("id", id);
        if (error) { setState("error"); setErr(error.message); return; }
      }
      setErr(null); setState("saved");
      window.setTimeout(() => setState((s) => (s === "saved" ? "idle" : s)), 1500);
    }, 700);
    return () => window.clearTimeout(t);
  }, [list]);
  const patch = (id: string, p: Partial<FolderTemplate>) => {
    dirty.current.add(id);
    setList((xs) => (xs ?? []).map((t) => (t.id === id ? { ...t, ...p } : p.is_default ? { ...t, is_default: false } : t)));
    if (p.is_default) (list ?? []).forEach((t) => { if (t.id !== id && t.is_default) dirty.current.add(t.id); });
  };
  const create = async (example: boolean) => {
    const row = { name: example ? "Standard client" : "New template", tree: example ? EXAMPLE_TREE() : [], is_default: !(list ?? []).length, sort: (list ?? []).length };
    const { data, error } = await supabase.from("client_folder_templates").insert(row).select("*").single();
    if (error || !data) { setErr(/client_folder_templates|relation|schema cache/i.test(error?.message ?? "") ? FOLDER_TEMPLATES_SQL : error?.message ?? "Not saved."); return; }
    const t: FolderTemplate = { id: (data as any).id, name: row.name, tree: cleanTree(row.tree), is_default: row.is_default, sort: row.sort };
    setList((xs) => [...(xs ?? []), t]); setOpenId(t.id); setErr(null);
  };
  const remove = async (id: string) => {
    setAskDel(false);
    const { error } = await supabase.from("client_folder_templates").delete().eq("id", id);
    if (error) { setErr(error.message); return; }
    const rest = (list ?? []).filter((t) => t.id !== id);
    setList(rest); setOpenId(rest[0]?.id ?? null);
  };
  // the tree, edited in place
  const mapTree = (xs: FolderNode[], fn: (xs: FolderNode[]) => FolderNode[], parent: string | null, at: string | null): FolderNode[] =>
    parent === at ? fn(xs) : xs.map((x) => ({ ...x, children: mapTree(x.children, fn, parent, x.id) }));
  const editTree = (parent: string | null, fn: (xs: FolderNode[]) => FolderNode[]) => { if (cur) patch(cur.id, { tree: mapTree(cur.tree, fn, parent, null) }); };
  const addTo = (parent: string | null) => { const n = { id: nodeId(), name: "", children: [] }; editTree(parent, (xs) => [...xs, n]); setFocus(n.id); };
  const rename = (parent: string | null, id: string, name: string) => editTree(parent, (xs) => xs.map((x) => (x.id === id ? { ...x, name } : x)));
  const drop = (parent: string | null, id: string) => editTree(parent, (xs) => xs.filter((x) => x.id !== id));
  const move = (parent: string | null, id: string, by: number) => editTree(parent, (xs) => {
    const i = xs.findIndex((x) => x.id === id), j = i + by;
    if (i < 0 || j < 0 || j >= xs.length) return xs;
    const n = [...xs]; [n[i], n[j]] = [n[j], n[i]]; return n;
  });
  const level = (xs: FolderNode[], parent: string | null, depth: number): React.ReactNode => (
    <div className={`fte-level ${depth ? "is-sub" : ""}`}>
      {xs.map((x, i) => (
        <div key={x.id} className="fte-node">
          <div className="fte-row" style={{ ["--d" as string]: depth } as CSSProperties}>
            <span className="fte-ico"><FolderGlyph /></span>
            <input className="fte-name" value={x.name} placeholder="Folder name" disabled={!canEdit} autoFocus={focus === x.id}
              onChange={(e) => rename(parent, x.id, e.target.value)} onFocus={() => setFocus(null)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTo(parent); } if (e.key === "Tab" && !e.shiftKey && x.name.trim()) { e.preventDefault(); addTo(x.id); } if (e.key === "Backspace" && !x.name) { e.preventDefault(); drop(parent, x.id); } }} />
            {canEdit && (
              <span className="fte-acts">
                <button type="button" onClick={() => addTo(x.id)} title="Add a folder inside" aria-label="Add a folder inside"><Ic d="M12 5v14M5 12h14" /></button>
                <button type="button" onClick={() => move(parent, x.id, -1)} disabled={i === 0} title="Move up" aria-label="Move up"><Ic d="M12 19V5M5 12l7-7 7 7" /></button>
                <button type="button" onClick={() => move(parent, x.id, 1)} disabled={i === xs.length - 1} title="Move down" aria-label="Move down"><Ic d="M12 5v14M19 12l-7 7-7-7" /></button>
                <button type="button" className="is-del" onClick={() => drop(parent, x.id)} title={x.children.length ? `Remove it and the ${countNodes(x.children)} inside` : "Remove"} aria-label="Remove"><Ic d="M18 6 6 18M6 6l12 12" /></button>
              </span>
            )}
          </div>
          {x.children.length > 0 && level(x.children, x.id, depth + 1)}
        </div>
      ))}
      {canEdit && (
        <button type="button" className="fte-add" style={{ ["--d" as string]: depth } as CSSProperties} onClick={() => addTo(parent)}>
          <Ic d="M12 5v14M5 12h14" />{depth ? "Add a subfolder" : "Add a folder"}
        </button>
      )}
    </div>
  );
  if (!list) return <div className="fte-skel" />;
  return (
    <div className="fte">
      {missing && <p className="fte-note">{FOLDER_TEMPLATES_SQL}</p>}
      {err && !missing && <p className="fte-err">{err}</p>}
      {!list.length ? (
        <div className="fte-start">
          <span className="fte-start-ico"><FolderGlyph /></span>
          <b>No folder templates yet</b>
          <span>Build the folders every client should have once — then add them to any client from its Folders tab in one click.</span>
          {canEdit && (
            <div className="fte-start-btns">
              <button type="button" className="fte-btn is-primary" onClick={() => void create(true)} disabled={missing}>Start from an example</button>
              <button type="button" className="fte-btn" onClick={() => void create(false)} disabled={missing}>Start empty</button>
            </div>
          )}
        </div>
      ) : (
        <div className="fte-grid">
          <nav className="fte-list" aria-label="Templates">
            {list.map((t) => (
              <button key={t.id} type="button" className={`fte-item ${t.id === openId ? "is-on" : ""}`} onClick={() => { setOpenId(t.id); setAskDel(false); }}>
                <span className="fte-item-ico"><FolderGlyph /></span>
                <span className="fte-item-txt"><b>{t.name || "Untitled"}</b><em>{countNodes(t.tree)} folders{t.is_default ? " · default" : ""}</em></span>
              </button>
            ))}
            {canEdit && <button type="button" className="fte-item is-new" onClick={() => void create(false)}><Ic d="M12 5v14M5 12h14" />New template</button>}
          </nav>
          {cur && (
            <div className="fte-ed">
              <div className="fte-head">
                <input className="fte-title" value={cur.name} placeholder="Template name" disabled={!canEdit} onChange={(e) => patch(cur.id, { name: e.target.value })} />
                <span className={`fte-state is-${state}`}>{state === "saving" ? "Saving…" : state === "saved" ? "Saved" : state === "error" ? "Not saved" : ""}</span>
                {canEdit && (
                  <label className="fte-def" title="Shown first when you add folders to a client">
                    <input type="checkbox" checked={cur.is_default} onChange={() => patch(cur.id, { is_default: !cur.is_default })} />Default
                  </label>
                )}
                {canEdit && (askDel ? (
                  <span className="fte-ask">Delete it? Clients keep their folders.
                    <button type="button" className="fte-btn" onClick={() => setAskDel(false)}>Keep</button>
                    <button type="button" className="fte-btn is-danger" onClick={() => void remove(cur.id)}>Delete</button>
                  </span>
                ) : <button type="button" className="fte-icon" onClick={() => setAskDel(true)} title="Delete template" aria-label="Delete template"><Ic d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></button>)}
              </div>
              <p className="fte-hint">Enter adds the next folder · Tab puts a new one inside · applying it to a client only adds the folders it's missing.</p>
              <div className="fte-tree">
                <div className="fte-root"><Ic d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />Client directory</div>
                {level(cur.tree, null, 0)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The Folders tab's "Templates" button: drops a template into the open folder. */
export function ApplyTemplateMenu({ clientId, parentId, parentName, folders, onApplied }: {
  clientId: string; parentId: string | null; parentName: string | null;
  folders: { id: string; parent_id: string | null; name: string; sort: number }[];
  onApplied: (folders: any[], msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<FolderTemplate[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    if (!list) loadFolderTemplates().then((r) => { setList([...r.list].sort((a, b) => Number(b.is_default) - Number(a.is_default))); setMissing(r.missing); });
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", down); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const apply = async (t: FolderTemplate) => {
    setBusy(t.id);
    const r = await applyFolderTemplate(clientId, t.tree, parentId, folders);
    setBusy(null); setOpen(false);
    onApplied(r.folders, r.error ? `Stopped: ${r.error}` : r.added ? `${r.added} folder${r.added === 1 ? "" : "s"} added from “${t.name}”${r.reused ? ` · ${r.reused} were already there` : ""}` : `Nothing to add — “${t.name}” is already all here`);
  };
  const shown = (list ?? []).find((t) => t.id === hover) ?? (list ?? [])[0];
  const preview = (xs: FolderNode[], d: number): React.ReactNode => xs.map((x) => (
    <div key={x.id}>
      <span className="cdt-pv-row" style={{ ["--d" as string]: d } as CSSProperties}><FolderGlyph />{x.name || "—"}</span>
      {preview(x.children, d + 1)}
    </div>
  ));
  return (
    <div className="cdt" ref={ref}>
      <button className={`cdir-btn ${open ? "is-on" : ""}`} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} title="Add a standard folder structure">
        <Ic d="M12 3 2 8l10 5 10-5zM2 13l10 5 10-5M2 17.5l10 5 10-5" />Templates
      </button>
      {open && (
        <div className="cdt-pop" role="menu">
          <div className="cdt-head"><b>Add a folder template</b><span>Into {parentName ? `“${parentName}”` : "the top of the directory"} · only missing folders are added</span></div>
          {!list ? <div className="cdt-skel" /> : !list.length ? (
            <p className="cdt-empty">{missing ? FOLDER_TEMPLATES_SQL : "No templates yet. Create them in Settings › Client page › Folder templates."}</p>
          ) : (
            <div className="cdt-body">
              <div className="cdt-list">
                {list.map((t) => (
                  <button key={t.id} type="button" role="menuitem" className={`cdt-opt ${shown?.id === t.id ? "is-on" : ""}`} onMouseEnter={() => setHover(t.id)} onFocus={() => setHover(t.id)}
                    onClick={() => void apply(t)} disabled={!!busy}>
                    <span className="cdt-opt-ico"><FolderGlyph /></span>
                    <span><b>{t.name || "Untitled"}</b><em>{countNodes(t.tree)} folders{t.is_default ? " · default" : ""}</em></span>
                    <i>{busy === t.id ? "Adding…" : "Add"}</i>
                  </button>
                ))}
              </div>
              {shown && <div className="cdt-pv" aria-label="Preview">{preview(shown.tree, 0)}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
