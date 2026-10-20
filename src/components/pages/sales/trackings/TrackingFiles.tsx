/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState, type DragEvent } from "react";
import { supabase } from "../../../api/supabase";
import Select from "../../../framework/Select";
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
  /** Set when the file belongs to one version of a revenue line (handoff_v2.sql). */
  line_id?: string | null;
  line_kind?: "product" | "service" | null;
  /** False once handed off (copied to the client) or excluded from the handoff. */
  share_client?: boolean | null;
}
export type { TFile };

interface Props {
  trackingId: string;
  phaseId: string | null;
  phases?: { id: string; name: string }[];
}

const BUCKET = "tracking-files";

export const prettySize = (b: number | null) => {
  if (!b) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
};

/** A little glyph per file kind. */
export const kindOf = (name: string, mime: string | null): string => {
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
export function FileIcon({ kind }: { kind: string }) {
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
      // Version documents live on their revenue line, not in this list.
      .then(({ data }) => { if (alive) setFiles(((data ?? []) as TFile[]).filter((f) => !f.line_id)); });
    // A proposal generated on the deal lands here too.
    const reload = (e: Event) => {
      if ((e as CustomEvent).detail?.trackingId !== trackingId) return;
      supabase.from("tracking_files").select("*").eq("tracking_id", trackingId).order("created_at", { ascending: false })
        .then(({ data }) => { if (alive) setFiles(((data ?? []) as TFile[]).filter((f) => !f.line_id)); });
    };
    window.addEventListener(TRACKING_FILES_EVENT, reload);
    return () => { alive = false; window.removeEventListener(TRACKING_FILES_EVENT, reload); };
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
/** Opens a sales document in a new tab. */
export async function openTrackingFile(path: string, bucket = BUCKET) {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 120);
  if (error || !data) { alert(error?.message ?? "Could not open file."); return; }
  window.open(data.signedUrl, "_blank");
}

/** Fired when a file is added to a deal from elsewhere (a generated proposal), so its list reloads. */
export const TRACKING_FILES_EVENT = "next:tracking-files";

/** Store a file made in the app (a generated proposal) as a deal document. */
export async function uploadTrackingFile(trackingId: string, phaseId: string | null, blob: Blob, name: string, note?: string | null): Promise<{ file: TFile | null; error: string | null }> {
  const { data: tr } = await supabase.from("trackings").select("tenant_id").eq("id", trackingId).maybeSingle();
  const tenantId = (tr as any)?.tenant_id;
  if (!tenantId) return { file: null, error: "Could not read the deal." };
  const safe = name.replace(/[^\w.\-]+/g, "_");
  const path = `${tenantId}/${trackingId}/${crypto.randomUUID()}_${safe}`;
  const up = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: blob.type || undefined, upsert: false });
  if (up.error) return { file: null, error: up.error.message };
  const { data, error } = await supabase.from("tracking_files").insert({
    tracking_id: trackingId, phase_id: phaseId, storage_path: path, name,
    mime: blob.type || null, size_bytes: blob.size, note: note ?? null,
  }).select().single();
  if (error) { await supabase.storage.from(BUCKET).remove([path]); return { file: null, error: error.message }; }
  window.dispatchEvent(new CustomEvent(TRACKING_FILES_EVENT, { detail: { trackingId } }));
  return { file: data as TFile, error: null };
}

/** Every document on a deal, version documents included (for the handoff). */
export async function loadAllTrackingFiles(trackingId: string): Promise<TFile[]> {
  const { data } = await supabase.from("tracking_files").select("*").eq("tracking_id", trackingId).order("created_at", { ascending: false });
  return (data ?? []) as TFile[];
}

/**
 * Contract proposals for ONE version of a revenue line (product or service).
 * Each version keeps its own PDF / Word / Excel files; they travel with the
 * handoff to the client's contract slots.
 */
export function LineDocs({ trackingId, lineId, lineKind, phaseId, versionLabel }: {
  trackingId: string; lineId: string; lineKind: "product" | "service"; phaseId: string | null; versionLabel: string;
}) {
  const [files, setFiles] = useState<TFile[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    setFiles([]); setErr(null);
    supabase.from("tracking_files").select("*").eq("line_id", lineId).order("created_at", { ascending: true })
      .then(({ data }) => { if (alive) setFiles((data ?? []) as TFile[]); });
    return () => { alive = false; };
  }, [lineId]);

  const upload = async (list: FileList | File[]) => {
    const arr = Array.from(list);
    if (!arr.length) return;
    setErr(null); setBusy((n) => n + arr.length);
    const { data: tr } = await supabase.from("trackings").select("tenant_id").eq("id", trackingId).maybeSingle();
    const tenantId = (tr as any)?.tenant_id;
    if (!tenantId) { setErr("Could not resolve the workspace — try again."); setBusy((n) => n - arr.length); return; }
    await Promise.all(arr.map(async (f) => {
      try {
        const safe = f.name.replace(/[^\w.\-]+/g, "_");
        const path = `${tenantId}/${trackingId}/${crypto.randomUUID()}_${safe}`;
        const up = await supabase.storage.from(BUCKET).upload(path, f, { contentType: f.type || undefined, upsert: false });
        if (up.error) { setErr(up.error.message); return; }
        const { data, error } = await supabase.from("tracking_files").insert({
          tracking_id: trackingId, phase_id: phaseId, storage_path: path, name: f.name,
          mime: f.type || null, size_bytes: f.size, line_id: lineId, line_kind: lineKind,
        }).select().single();
        if (error) {
          await supabase.storage.from(BUCKET).remove([path]);
          setErr(/line_id|line_kind|column/i.test(error.message) ? "Run handoff_v2.sql in Supabase to enable version documents." : error.message);
          return;
        }
        setFiles((xs) => [...xs, data as TFile]);
      } finally { setBusy((n) => n - 1); }
    }));
    if (inputRef.current) inputRef.current.value = "";
  };

  const remove = async (f: TFile) => {
    setConfirmDel(null);
    setFiles((xs) => xs.filter((x) => x.id !== f.id));
    await supabase.storage.from(BUCKET).remove([f.storage_path]);
    await supabase.from("tracking_files").delete().eq("id", f.id);
  };

  const drop = {
    onDragOver: (e: DragEvent) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } },
    onDragLeave: (e: DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); },
    onDrop: (e: DragEvent) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files.length) upload(e.dataTransfer.files); },
  };

  return (
    <div className={`tf-line ${over ? "is-over" : ""} ${files.length ? "has-files" : ""}`} {...drop}>
      <div className="tf-line-head">
        <span className="tf-line-t">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6" /></svg>
          Proposal documents <em>{versionLabel}</em>
        </span>
        <button type="button" className="tf-line-add" onClick={() => inputRef.current?.click()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          Add
        </button>
      </div>
      {files.length === 0 && busy === 0 ? (
        <button type="button" className="tf-line-drop" onClick={() => inputRef.current?.click()}>
          Drop the PDF, Word or Excel proposal for this version
        </button>
      ) : (
        <div className="tf-line-list">
          {files.map((f) => (
            <div className="tf-line-file" key={f.id} title={f.name}>
              <FileIcon kind={kindOf(f.name, f.mime)} />
              <button type="button" className="tf-line-name" onClick={() => openTrackingFile(f.storage_path)}>{f.name}</button>
              <span className="tf-line-size">{prettySize(f.size_bytes)}</span>
              {confirmDel === f.id ? (
                <span className="tf-line-confirm">
                  <button type="button" className="is-del" onClick={() => remove(f)}>Delete</button>
                  <button type="button" onClick={() => setConfirmDel(null)}>Keep</button>
                </span>
              ) : (
                <button type="button" className="tf-line-x" onClick={() => setConfirmDel(f.id)} aria-label={`Remove ${f.name}`}>×</button>
              )}
            </div>
          ))}
          {busy > 0 && <div className="tf-line-file is-busy"><span className="tf-line-spin" />Uploading {busy}…</div>}
        </div>
      )}
      {err && <p className="tf-line-err">{err}</p>}
      <input ref={inputRef} type="file" multiple hidden accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.odt,.ods,image/*"
        onChange={(e) => e.target.files && upload(e.target.files)} />
    </div>
  );
}
