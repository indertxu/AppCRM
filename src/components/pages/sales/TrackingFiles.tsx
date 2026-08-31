/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from "react";
import { supabase } from "../../api/supabase";
import "./TrackingFiles.css";

interface TFile {
  id: string;
  tracking_id: string;
  phase_id: string | null;
  storage_path: string;
  name: string;
  note: string | null;
  mime: string | null;
  size_bytes: number | null;
  created_at: string;
}

interface Props {
  trackingId: string;
  phaseId: string | null;
}

const BUCKET = "tracking-files";

const prettySize = (b: number | null) => {
  if (!b) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
};

/** A little glyph per file kind. */
const kindOf = (name: string, mime: string | null): string => {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf" || mime === "application/pdf") return "PDF";
  if (["doc", "docx"].includes(ext)) return "DOC";
  if (["xls", "xlsx", "csv"].includes(ext)) return "XLS";
  if (["ppt", "pptx"].includes(ext)) return "PPT";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "IMG";
  if (["zip", "rar", "7z"].includes(ext)) return "ZIP";
  return ext ? ext.slice(0, 3).toUpperCase() : "•";
};

export default function TrackingFiles({ trackingId, phaseId }: Props) {
  const [files, setFiles] = useState<TFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);   // id being renamed
  const [noteFor, setNoteFor] = useState<string | null>(null);   // id whose note is open
  const [tenantId, setTenantId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    // Resolve this tracking's tenant so uploads are namespaced correctly.
    supabase.from("trackings").select("tenant_id").eq("id", trackingId).maybeSingle()
      .then(({ data }) => { if (alive) setTenantId((data as any)?.tenant_id ?? null); });
    supabase.from("tracking_files").select("*")
      .eq("tracking_id", trackingId)
      .order("created_at", { ascending: false })
      .then(({ data }) => { if (alive) setFiles((data ?? []) as TFile[]); });
    return () => { alive = false; };
  }, [trackingId]);

  const upload = async (fileList: FileList | File[]) => {
    const list = Array.from(fileList);
    if (list.length === 0) return;
    if (!tenantId) { setErr("Still loading — try again in a moment."); return; }
    setBusy(true); setErr(null);
    try {
      for (const f of list) {
        const safe = f.name.replace(/[^\w.\-]+/g, "_");
        const path = `${tenantId}/${trackingId}/${crypto.randomUUID()}_${safe}`;
        const up = await supabase.storage.from(BUCKET).upload(path, f, {
          contentType: f.type || undefined,
          upsert: false,
        });
        if (up.error) { setErr(up.error.message); continue; }
        const { data, error } = await supabase.from("tracking_files").insert({
          tracking_id: trackingId,
          phase_id: phaseId,
          storage_path: path,
          name: f.name,
          mime: f.type || null,
          size_bytes: f.size,
        }).select().single();
        if (error) { setErr(error.message); continue; }
        setFiles((xs) => [data as TFile, ...xs]);
      }
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const download = async (f: TFile) => {
    const { data, error } = await supabase.storage.from(BUCKET)
      .createSignedUrl(f.storage_path, 60);
    if (error || !data) { setErr(error?.message ?? "Could not open file."); return; }
    window.open(data.signedUrl, "_blank");
  };

  const rename = async (id: string, name: string) => {
    const clean = name.trim();
    setEditing(null);
    if (!clean) return;
    setFiles((xs) => xs.map((f) => f.id === id ? { ...f, name: clean } : f));
    await supabase.from("tracking_files").update({ name: clean }).eq("id", id);
  };

  const saveNote = async (id: string, note: string) => {
    const v = note.trim() || null;
    setFiles((xs) => xs.map((f) => f.id === id ? { ...f, note: v } : f));
    await supabase.from("tracking_files").update({ note: v }).eq("id", id);
  };

  const remove = async (f: TFile) => {
    setFiles((xs) => xs.filter((x) => x.id !== f.id));
    await supabase.storage.from(BUCKET).remove([f.storage_path]);
    await supabase.from("tracking_files").delete().eq("id", f.id);
  };

  return (
    <div className="tf">
      <div
        className={`tf-drop ${dragOver ? "is-over" : ""} ${busy ? "is-busy" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) upload(e.dataTransfer.files); }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter") inputRef.current?.click(); }}
      >
        <input ref={inputRef} type="file" multiple hidden
          onChange={(e) => e.target.files && upload(e.target.files)} />
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 16V4M8 8l4-4 4 4" /><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
        </svg>
        <span className="tf-drop-main">{busy ? "Uploading…" : "Drop files here or click to attach"}</span>
        <span className="tf-drop-sub">PDF, Word, Excel, images…</span>
      </div>

      {err && <p className="tf-err">{err}</p>}

      {files.length > 0 && (
        <div className="tf-list">
          {files.map((f) => (
            <div className={`tf-item ${f.note ? "has-note" : ""}`} key={f.id}>
              {f.note && <span className="tf-note-tip" role="tooltip">{f.note}</span>}
              <span className={`tf-kind tf-kind-${kindOf(f.name, f.mime).toLowerCase()}`}>{kindOf(f.name, f.mime)}</span>

              <div className="tf-body">
                {editing === f.id ? (
                  <input
                    className="tf-rename"
                    defaultValue={f.name}
                    autoFocus
                    onBlur={(e) => rename(f.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") rename(f.id, (e.target as HTMLInputElement).value);
                      if (e.key === "Escape") setEditing(null);
                    }}
                  />
                ) : (
                  <button className="tf-name" onClick={() => download(f)} title="Download">
                    {f.name}
                    {f.note && (
                      <span className="tf-note-dot" aria-label="Has a note">
                        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 4h16v12H7l-3 3z" /></svg>
                      </span>
                    )}
                  </button>
                )}
                <span className="tf-meta">
                  {prettySize(f.size_bytes)}
                  {f.size_bytes ? " · " : ""}
                  {new Date(f.created_at).toLocaleDateString()}
                </span>
              </div>

              <div className="tf-actions">
                <button className="tf-act" title="Rename" onClick={() => setEditing(f.id)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
                </button>
                <button className={`tf-act ${f.note ? "has-note" : ""}`} title={f.note ? "Edit note" : "Add note"} onClick={() => setNoteFor(noteFor === f.id ? null : f.id)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                </button>
                <button className="tf-act tf-del" title="Remove" onClick={() => remove(f)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
                </button>
              </div>

              {noteFor === f.id && (
                <div className="tf-noteedit">
                  <textarea
                    defaultValue={f.note ?? ""}
                    placeholder="What's in this file? (shown on hover)"
                    autoFocus
                    onBlur={(e) => { saveNote(f.id, e.target.value); setNoteFor(null); }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setNoteFor(null);
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { saveNote(f.id, (e.target as HTMLTextAreaElement).value); setNoteFor(null); }
                    }}
                  />
                  <span className="tf-noteedit-hint">Enter ⌘ to save · Esc to cancel</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}