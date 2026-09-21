/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from "react";
import { supabase } from "../../api/supabase";
import Select from "../../framework/Select";
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
  phases?: { id: string; name: string }[];
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

// A coloured document icon per file type (a folded-corner page with the label).
const KIND_COLOR: Record<string, string> = {
  PDF: "#d64545", DOC: "#2b6cb0", XLS: "#1f9d55", PPT: "#dd6b20", IMG: "#7c5cd6", ZIP: "#8a6d3b",
};
// Font Awesome file-type icons (loaded via CDN <link> in index.html).
const KIND_FA: Record<string, string> = {
  PDF: "fa-file-pdf", DOC: "fa-file-word", XLS: "fa-file-excel",
  PPT: "fa-file-powerpoint", IMG: "fa-file-image", ZIP: "fa-file-zipper",
};
function FileIcon({ kind }: { kind: string }) {
  const color = KIND_COLOR[kind] ?? "#5a7d6d";
  const fa = KIND_FA[kind] ?? "fa-file-lines";
  return (
    <span className="tf-fi" style={{ ["--fi" as any]: color }}>
      <i className={`fa-solid ${fa}`} aria-hidden="true" />
    </span>
  );
}

export default function TrackingFiles({ trackingId, phaseId, phases = [] }: Props) {
  const [files, setFiles] = useState<TFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);   // id being renamed
  const [noteFor, setNoteFor] = useState<string | null>(null);   // id whose note is open
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [allOpen, setAllOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"recent" | "old" | "name">("recent");
  const [fPhase, setFPhase] = useState("");
  const phaseName = (id: string | null) => phases.find((p) => p.id === id)?.name ?? "No phase";
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

  // Newest first; the card shows the 4 most recent in a 2x2 grid.
  const sorted = [...files].sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  const norm = (s: string) => (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const modalFiles = [...files]
    .filter((f) => { const n = norm(q.trim()); return !n || norm(f.name).includes(n) || norm(f.note ?? "").includes(n); })
    .filter((f) => !fPhase || f.phase_id === fPhase)
    .sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      const cmp = (a.created_at || "").localeCompare(b.created_at || "");
      return sort === "old" ? cmp : -cmp;
    });
  // Phases actually present among the files, for the phase filter.
  const filePhaseIds = Array.from(new Set(files.map((f) => f.phase_id).filter(Boolean))) as string[];
  const recent = sorted.slice(0, 4);

  const cell = (f: TFile) => (
    <div className="tf-cell" key={f.id}>
      <button className="tf-cell-open" onClick={() => download(f)} title={`Download ${f.name}`}>
        <FileIcon kind={kindOf(f.name, f.mime)} />
        <span className="tf-cell-info">
          <span className="tf-cell-name">{f.name}</span>
          <span className="tf-cell-meta">
            <span className="tf-cell-size">{prettySize(f.size_bytes)}</span>
            {f.created_at && <span className="tf-cell-date">{new Date(f.created_at).toLocaleDateString(undefined, { day: "2-digit", month: "short" })}</span>}
          </span>
        </span>
      </button>
      {f.note && <span className="tf-cell-note" title="Has a note">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
      </span>}
      {f.note && <span className="tf-cell-tip" role="tooltip">{f.note}</span>}
      <span className="tf-cell-hover">
        <button className="tf-cell-act" onClick={(e) => { e.stopPropagation(); download(f); }} title="Download" aria-label="Download">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>
        </button>
        <button className="tf-cell-act tf-cell-del" onClick={(e) => { e.stopPropagation(); remove(f); }} title="Remove" aria-label="Remove">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
        </button>
      </span>
    </div>
  );

  const fileRow = (f: TFile) => (
    <div className={`tf-item ${f.note ? "has-note" : ""}`} key={f.id}>
      {f.note && <span className="tf-note-tip" role="tooltip">{f.note}</span>}
      <FileIcon kind={kindOf(f.name, f.mime)} />
      <div className="tf-body">
        {editing === f.id ? (
          <input className="tf-rename" defaultValue={f.name} autoFocus
            onBlur={(e) => rename(f.id, e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") rename(f.id, (e.target as HTMLInputElement).value); if (e.key === "Escape") setEditing(null); }} />
        ) : (
          <button className="tf-name" onClick={() => download(f)} title="Download">
            {f.name}
            {f.note && <span className="tf-note-dot" aria-label="Has a note"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 4h16v12H7l-3 3z" /></svg></span>}
          </button>
        )}
        <span className="tf-meta">{prettySize(f.size_bytes)}{f.size_bytes ? " · " : ""}{new Date(f.created_at).toLocaleDateString()}</span>
      </div>
      <div className="tf-actions">
        <button className="tf-act" title="Rename" onClick={() => setEditing(f.id)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg></button>
        <button className={`tf-act ${f.note ? "has-note" : ""}`} title={f.note ? "Edit note" : "Add note"} onClick={() => setNoteFor(noteFor === f.id ? null : f.id)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg></button>
        <button className="tf-act tf-del" title="Remove" onClick={() => remove(f)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg></button>
      </div>
      {noteFor === f.id && (
        <div className="tf-noteedit">
          <textarea defaultValue={f.note ?? ""} placeholder="What's in this file? (shown on hover)" autoFocus
            onBlur={(e) => { saveNote(f.id, e.target.value); setNoteFor(null); }}
            onKeyDown={(e) => { if (e.key === "Escape") setNoteFor(null); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { saveNote(f.id, (e.target as HTMLTextAreaElement).value); setNoteFor(null); } }} />
          <span className="tf-noteedit-hint">Enter ⌘ to save · Esc to cancel</span>
        </div>
      )}
    </div>
  );

  return (
    <div className="tf">
      <div className="tf-header">
        <h3 className="sl-panel-title">Documents{files.length > 0 && <span>{files.length}</span>}</h3>
        {files.length > 0 && (
          <button className="tf-manage-icon" onClick={() => setAllOpen(true)} title="Manage files" aria-label="Manage files">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
          </button>
        )}
      </div>

      {files.length === 0 && (
        <div
          className={`tf-drop tf-drop-compact ${dragOver ? "is-over" : ""} ${busy ? "is-busy" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) upload(e.dataTransfer.files); }}
          onClick={() => inputRef.current?.click()}
          role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === "Enter") inputRef.current?.click(); }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 16V4M8 8l4-4 4 4" /><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
          </svg>
          <span className="tf-drop-main">{busy ? "Uploading…" : "Drop files or click to attach"}</span>
        </div>
      )}
      <input ref={inputRef} type="file" multiple hidden onChange={(e) => e.target.files && upload(e.target.files)} />

      {err && <p className="tf-err">{err}</p>}

      {files.length > 0 && (
        <div
          className={`tf-grid ${dragOver ? "is-over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) upload(e.dataTransfer.files); }}
        >
          {recent.map(cell)}
        </div>
      )}

      {allOpen && (
        <div className="tf-modal-backdrop" onMouseDown={() => setAllOpen(false)}>
          <div className="tf-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="tf-modal-head">
              <h3 className="tf-modal-title">Documents<span>{files.length}</span></h3>
              <div className="tf-modal-head-actions">
                <button className="tf-modal-upload" onClick={() => inputRef.current?.click()} disabled={busy}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
                  {busy ? "Uploading…" : "Add files"}
                </button>
                <button className="tf-modal-x" onClick={() => setAllOpen(false)} aria-label="Close">×</button>
              </div>
            </div>
            <div className="tf-modal-toolbar">
              <div className="tf-search">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search files…" />
                {q && <button className="tf-search-x" onClick={() => setQ("")} aria-label="Clear">×</button>}
              </div>
              <div className="tf-sort">
                <Select value={sort} onChange={(v) => setSort(v as any)}
                  options={[{ value: "recent", label: "Newest" }, { value: "old", label: "Oldest" }, { value: "name", label: "Name A–Z" }]} />
              </div>
              {filePhaseIds.length > 1 && (
                <div className="tf-sort">
                  <Select value={fPhase} onChange={setFPhase}
                    options={[{ value: "", label: "All phases" }, ...filePhaseIds.map((id) => ({ value: id, label: phaseName(id) }))]} />
                </div>
              )}
            </div>
            <div className="tf-modal-body">
              {modalFiles.length === 0 ? (
                <p className="tf-empty">{q ? "No files match your search." : "No files."}</p>
              ) : (
                <div className="tf-list">
                  {modalFiles.map(fileRow)}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}