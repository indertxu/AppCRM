/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState } from "react";
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
            <span>Drop files here, or create a folder to organise them.</span>
          </div>
        )}
        {busy && <div className="cdir-uploading">Uploading…</div>}
      </div>
    </div>
  );
}