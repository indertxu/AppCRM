/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../../api/supabase";
import Select from "../../../framework/Select";
import { listDocTemplates, saveDocTemplate, pickDocTemplate, docThemeSeed, uploadDocImage, printDocHtml, docToPdfBlob, downloadBlob, loadDocVariables, type DocTemplateRow } from "./proposalApi";
import { defaultDocTemplate, DEFAULT_DOC_THEME, setDocCustomVars, type DocKind, type DocTemplate, type DocInstance, type ProposalData, type ContractTerms, type DocTheme, type DocBlock } from "./proposalGen";
import { DocBuilder, docHtmlFor, StartFrom, AiReview, type DocCtxIn, type StartPicked } from "../../settings/ProposalTemplateEditor";
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
  // web pages (HTML proposals) open as pages, not as their source text
  if (/\.html?$/i.test(path)) {
    const win = window.open("", "_blank");
    const { data, error } = await supabase.storage.from(bucket).download(path);
    if (error || !data) { win?.close(); alert(error?.message ?? "Could not open file."); return; }
    const url = URL.createObjectURL(new Blob([await data.text()], { type: "text/html" }));
    if (win) win.location.href = url; else window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    return;
  }
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 120);
  if (error || !data) { alert(error?.message ?? "Could not open file."); return; }
  window.open(data.signedUrl, "_blank");
}

/** A deal document's bytes (to read a signed contract). */
export async function readTrackingFileBytes(path: string, bucket = BUCKET): Promise<ArrayBuffer> {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) throw new Error(error?.message ?? "Could not read the file.");
  return await data.arrayBuffer();
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

/* =====================================================================
 *  Proposal / contract studio of a deal: the web document built from a
 *  template, edited for this proposal only, exported as page or PDF.
 * ===================================================================== */
type HtmlDocs = Partial<Record<DocKind, DocInstance>>;
const DS_ICON = {
  pdf: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h2a1.5 1.5 0 0 1 0 3H8v-5M13 16v-5h1.5a2.5 2.5 0 0 1 0 5zM18 11h-2v5M16 13.5h1.5",
  globe: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20",
  save: "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8",
  print: "M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z",
  down: "M12 3v12M7 10l5 5 5-5M4 19h16", tpl: "M4 4h16v16H4zM4 9h16M9 9v11", undo: "M3 7v6h6M3 13a9 9 0 1 0 3-7.7L3 7", chev: "M6 9l6 6 6-6",
  deck: "M3 4h18v13H3zM8 21h8M12 17v4", spark: "M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z",
};
const DsIco = ({ d }: { d: keyof typeof DS_ICON }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={DS_ICON[d]} /></svg>;
const fileSafe = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w\-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 60);

export function DocStudio({ trackingId, phaseId, kind: kind0, proposal, data, productIds, serviceIds, seller, sector, contract, dealValue, onClose, onSaveDoc, onSavedFile, onLegacyDeck }: {
  trackingId: string; phaseId: string | null;
  /** What opens first: the proposal document or the contract. */
  kind: DocKind;
  proposal: { id: string; name: string; doc: any };
  data: ProposalData; productIds: string[]; serviceIds: string[];
  seller: { name?: string; email?: string; phone?: string };
  /** The deal's company sector: picks the template. */
  sector?: string | null;
  /** The deal's contract terms (contract panel), if any. */
  contract?: ContractTerms | null;
  /** The deal's potential revenue. */
  dealValue?: number | null;
  onClose: () => void;
  /** Saves this proposal's documents (both kinds). Returns an error or null. */
  onSaveDoc: (html: HtmlDocs) => Promise<string | null>;
  /** A file was kept on the deal from this proposal. */
  onSavedFile?: (fileId: string, kind: DocKind) => Promise<string | null | void> | void;
  /** Opens the old PowerPoint deck of this proposal (when the company still has decks). */
  onLegacyDeck?: () => void;
}) {
  const [kind, setKind] = useState<DocKind>(kind0);
  const [templates, setTemplates] = useState<DocTemplateRow[] | null | undefined>(undefined);
  const [seed, setSeed] = useState<Partial<DocTheme>>({});
  const [docs, setDocs] = useState<HtmlDocs>(() => (proposal.doc?.html && typeof proposal.doc.html === "object" ? proposal.doc.html : {}));
  const [save, setSave] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [ask, setAsk] = useState<null | "reset" | "totemplate">(null);
  /** "Start from…" picker, the AI review after it, and a template to keep once reviewed */
  const [from, setFrom] = useState(false);
  const [ai, setAi] = useState(false);
  const [tplAfter, setTplAfter] = useState<StartPicked | null>(null);
  /** the deal's other values: stage, company and contacts' data, team, custom fields (multi-choice joined) */
  const [extra, setExtra] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    listDocTemplates().then(setTemplates).catch(() => setTemplates([]));
    docThemeSeed().then(setSeed).catch(() => undefined);
  }, []);
  useEffect(() => {
    let live = true;
    loadDocVariables(trackingId).then((r) => { if (!live) return; setDocCustomVars(r.defs); setExtra(r.values); }).catch(() => { if (live) setExtra({}); });
    return () => { live = false; };
  }, [trackingId]);

  const ofKind = useMemo(() => (templates ?? []).filter((t) => t.kind === kind), [templates, kind]);
  const builtIn = useMemo<DocTemplate>(() => ({ ...defaultDocTemplate(kind, "es", { ...DEFAULT_DOC_THEME, ...seed }), id: null }), [kind, seed]);
  const inst = docs[kind];
  const tpl: DocTemplate = useMemo(() => {
    const own = inst?.templateId ? ofKind.find((t) => t.id === inst.templateId) : null;
    return own ?? pickDocTemplate(ofKind, kind, sector) ?? builtIn;
  }, [inst?.templateId, ofKind, kind, sector, builtIn]);
  // first time on this kind: copy the template
  useEffect(() => {
    if (templates === undefined || inst) return;
    setDocs((d) => ({ ...d, [kind]: { templateId: tpl.id ?? null, blocks: JSON.parse(JSON.stringify(tpl.blocks)), values: {}, theme: tpl.theme, assets: tpl.assets ?? [] } }));
  }, [templates, inst, kind, tpl]);

  // autosave (debounced)
  const first = useRef(true);
  const docsRef = useRef(docs); docsRef.current = docs;
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setSave("saving");
    const t = setTimeout(async () => {
      const e = await onSaveDoc(docsRef.current);
      setSave(e ? "error" : "saved"); setSaveErr(e);
    }, 1100);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs]);

  const upd = useCallback((patch: Partial<DocInstance>) => setDocs((d) => ({ ...d, [kind]: { ...(d[kind] as DocInstance), ...patch, updatedAt: new Date().toISOString() } })), [kind]);
  const theme = inst?.theme ?? tpl.theme;
  const ctx: DocCtxIn = useMemo(() => ({
    data, lang: tpl.lang, sellerName: seller.name, sellerEmail: seller.email, sellerPhone: seller.phone, proposalName: proposal.name, contract: contract ?? null, dealValue: dealValue ?? null,
    extra,
  }), [data, tpl.lang, seller.name, seller.email, seller.phone, proposal.name, contract, dealValue, extra]);
  const title = `${kind === "contract" ? "Contrato" : "Propuesta"} · ${data.client.name || proposal.name}`;
  const htmlOf = (mode: "view" | "print") => docHtmlFor(mode, { theme, blocks: inst?.blocks ?? [], kind, lang: tpl.lang, ctx, terms: tpl.terms, values: inst?.values, productIds, serviceIds, title });
  const baseName = `${fileSafe(theme.company || "Doc")}-${kind === "contract" ? "Contrato" : "Propuesta"}-${fileSafe(data.client.name || proposal.name)}`;

  const switchTemplate = (id: string) => {
    const t = id === "builtin" ? builtIn : ofKind.find((x) => x.id === id);
    if (!t) return;
    setDocs((d) => ({ ...d, [kind]: { templateId: t.id ?? null, blocks: JSON.parse(JSON.stringify(t.blocks)), values: d[kind]?.values ?? {}, theme: t.theme, assets: Array.from(new Set([...(d[kind]?.assets ?? []), ...(t.assets ?? [])])) } }));
    setMsg({ kind: "ok", text: `Now using “${t.name}”. Your field values were kept.` });
  };
  const keepFile = async (fmt: "pdf" | "html") => {
    setMenu(false); setBusy(fmt); setMsg(null);
    try {
      const blob = fmt === "pdf" ? await docToPdfBlob(htmlOf("print")) : new Blob([htmlOf("view")], { type: "text/html" });
      const name = `${baseName}.${fmt}`;
      const { file, error } = await uploadTrackingFile(trackingId, phaseId, blob, name, `${kind === "contract" ? "Contract" : "Proposal"} · ${proposal.name}`);
      if (error || !file) throw new Error(error ?? "Could not save the file.");
      const e2 = await onSavedFile?.(file.id, kind);
      if (e2) throw new Error(e2);
      setMsg({ kind: "ok", text: `${name} is now in the deal's documents.` });
    } catch (e: any) { setMsg({ kind: "err", text: e?.message ?? "Could not save the file." }); }
    finally { setBusy(null); }
  };
  const download = async (fmt: "pdf" | "html") => {
    setMenu(false);
    if (fmt === "html") { downloadBlob(new Blob([htmlOf("view")], { type: "text/html" }), `${baseName}.html`); return; }
    setBusy("dl");
    try { downloadBlob(await docToPdfBlob(htmlOf("print")), `${baseName}.pdf`); }
    catch (e: any) { setMsg({ kind: "err", text: e?.message ?? "Could not make the PDF." }); }
    finally { setBusy(null); }
  };
  const fresh = !!inst?.source;
  const toTemplate = async () => {
    setAsk(null); setBusy("tpl");
    const next: DocTemplate = { ...tpl, blocks: inst?.blocks ?? tpl.blocks, theme, assets: Array.from(new Set([...(tpl.assets ?? []), ...(inst?.assets ?? [])])) };
    if (inst?.source) { next.id = null; next.isDefault = false; next.name = inst.source.name; next.reference = { fileName: inst.source.name, kind: "deal", at: inst.source.at }; }
    else if (!tpl.id) next.name = `${tpl.name} (${data.client.name || "deal"})`;
    const r = await saveDocTemplate(next);
    setBusy(null);
    if (r.error) { setMsg({ kind: "err", text: r.error }); return; }
    setMsg({ kind: "ok", text: tpl.id && !fresh ? `“${tpl.name}” now starts with this layout. Values stay variables.` : "Saved as a new template." });
    if ((fresh || !tpl.id) && r.id) upd({ templateId: r.id, source: undefined });
    listDocTemplates().then(setTemplates).catch(() => undefined);
  };
  /** The document now starts from another deal's document or a file: the AI then looks for the other client's values. */
  const startFrom = (r: StartPicked) => {
    setFrom(false);
    setDocs((d) => ({ ...d, [kind]: { templateId: null, blocks: r.blocks, values: d[kind]?.values ?? {}, theme: r.theme, assets: Array.from(new Set([...(d[kind]?.assets ?? []), ...r.assets])), source: { name: r.name, at: new Date().toISOString() }, updatedAt: new Date().toISOString() } }));
    setTplAfter(r.alsoTemplate ? r : null);
    setMsg({ kind: "ok", text: `Now built from ${r.reference.fileName}. Your field values were kept.` });
    setAi(true);
  };
  /** Keeps what was picked (after the AI review) as a new template. */
  const keepAsTemplate = async (r: StartPicked, blocks: DocBlock[]) => {
    setTplAfter(null); setBusy("tpl");
    const b = defaultDocTemplate(kind, tpl.lang, r.theme);
    const res = await saveDocTemplate({ ...b, id: null, name: r.name || b.name, blocks, theme: r.theme, assets: r.assets, terms: { ...b.terms, ...(r.terms ?? {}) }, reference: r.reference });
    setBusy(null);
    if (res.error || !res.id) { setMsg({ kind: "err", text: res.error ?? "Could not save the template." }); return; }
    setMsg({ kind: "ok", text: `Saved as the template “${r.name || b.name}”.` });
    await listDocTemplates().then(setTemplates).catch(() => undefined);
    upd({ templateId: res.id, source: undefined });
  };
  const reset = () => { setAsk(null); upd({ blocks: JSON.parse(JSON.stringify(tpl.blocks)), theme: tpl.theme }); setMsg({ kind: "ok", text: "Back to the template. Your field values were kept." }); };

  if (templates === undefined || !inst) {
    return createPortal(<div className="dss-load"><span className="dss-spin" /><b>Opening the {kind}…</b></div>, document.body);
  }
  const saveLabel = save === "saving" ? "Saving…" : save === "saved" ? "All changes saved" : save === "error" ? (saveErr ?? "Not saved") : "Changes save by themselves";
  return (
    <>
      <DocBuilder
        mode="deal" kind={kind} lang={tpl.lang} title={title}
        theme={theme} onTheme={(t) => upd({ theme: t })}
        blocks={inst.blocks} onBlocks={(b: DocBlock[]) => upd({ blocks: b })}
        terms={tpl.terms}
        values={inst.values} onValues={(v) => upd({ values: v })}
        ctx={ctx} productIds={productIds} serviceIds={serviceIds}
        catalog={{ products: productIds.map((id, i) => ({ id, name: data.products[i]?.name ?? "Product" })), services: serviceIds.map((id, i) => ({ id, name: data.services[i]?.name ?? "Service" })) }}
        uploadImage={(f) => uploadDocImage(f, "deal")}
        assets={inst.assets ?? tpl.assets ?? []} onAssets={(a) => upd({ assets: a })}
        previewHtml={() => htmlOf("view")}
        head={(
          <div className="dss-head">
            <div className="dxb-seg dss-kind" role="tablist" aria-label="Document">
              <button type="button" className={kind === "proposal" ? "is-on" : ""} onClick={() => setKind("proposal")}>Proposal</button>
              <button type="button" className={kind === "contract" ? "is-on" : ""} onClick={() => setKind("contract")}>Contract</button>
            </div>
            <div className="dxb-title">
              <span className="dxb-eyebrow">{proposal.name}</span>
              <b>{data.client.name || "Client"}</b>
            </div>
            <div className="dss-tpl">
              <span><DsIco d="tpl" />Template</span>
              <Select size="sm" value={inst.source ? "source" : inst.templateId ?? "builtin"} onChange={(v) => { if (v !== "source") switchTemplate(v); }} aria-label="Template"
                options={[...(inst.source ? [{ value: "source", label: inst.source.name, hint: "picked" }] : []), ...ofKind.map((t) => ({ value: t.id, label: t.name, hint: t.sectors.length ? t.sectors.join(", ") : t.isDefault ? "default" : undefined })), ...(!ofKind.length || (!inst.templateId && !inst.source) ? [{ value: "builtin", label: "Our design", hint: "built-in" }] : [])]} />
              <button type="button" className="dxb-btn is-sm dss-from" onClick={() => setFrom(true)} title="Start from another template, a document made on a deal, or a file"><DsIco d="spark" />Start from…</button>
            </div>
          </div>
        )}
        actions={(
          <>
            {onLegacyDeck && kind === "proposal" && <button type="button" className="dxb-btn" onClick={onLegacyDeck} title="The old PowerPoint deck of this proposal"><DsIco d="deck" />PowerPoint</button>}
            <button type="button" className="dxb-btn" onClick={() => printDocHtml(htmlOf("print"))} title="Print, or Save as PDF from the print dialog"><DsIco d="print" />Print</button>
            <div className="dss-menu">
              <button type="button" className="dxb-btn is-primary" onClick={() => setMenu((m) => !m)} disabled={!!busy} aria-expanded={menu}>
                {busy && busy !== "tpl" ? <span className="dxb-spin" /> : <DsIco d="save" />}Export<DsIco d="chev" />
              </button>
              {menu && (
                <div className="dss-pop" role="menu" onMouseLeave={() => setMenu(false)}>
                  <button type="button" role="menuitem" onClick={() => keepFile("pdf")}><DsIco d="pdf" /><span><b>Save PDF to the deal</b><i>Goes with the handoff to the client's folders</i></span></button>
                  <button type="button" role="menuitem" onClick={() => keepFile("html")}><DsIco d="globe" /><span><b>Save web page to the deal</b><i>Interactive, opens in any browser</i></span></button>
                  <hr />
                  <button type="button" role="menuitem" onClick={() => download("pdf")}><DsIco d="down" /><span><b>Download PDF</b><i>A4, ready to send</i></span></button>
                  <button type="button" role="menuitem" onClick={() => download("html")}><DsIco d="down" /><span><b>Download web page</b><i>A single .html file</i></span></button>
                  <hr />
                  <button type="button" role="menuitem" onClick={() => { setMenu(false); setAsk("totemplate"); }}><DsIco d="tpl" /><span><b>{tpl.id && !fresh ? "Save layout to template" : "Save as a new template"}</b><i>Next {kind === "contract" ? "contracts" : "proposals"} start like this one</i></span></button>
                  <button type="button" role="menuitem" onClick={() => { setMenu(false); setAi(true); }}><DsIco d="spark" /><span><b>AI suggestions</b><i>Values of another client left in the text</i></span></button>
                  <button type="button" role="menuitem" onClick={() => { setMenu(false); setAsk("reset"); }}><DsIco d="undo" /><span><b>Back to the template</b><i>Drops this proposal's layout changes</i></span></button>
                </div>
              )}
            </div>
          </>
        )}
        status={(
          <>
            <span className={`dss-save is-${save}`}><i />{saveLabel}</span>
            {msg && <span className={`dxb-msg is-${msg.kind}`}>{msg.text}</span>}
            {busy === "pdf" || busy === "dl" ? <span className="dxb-msg">Making the PDF…</span> : null}
            {templates === null && <span className="dxb-msg">Run 28_proposal_html.sql to keep templates — this {kind} uses our built-in design.</span>}
          </>
        )}
        onClose={onClose}
      />
      {ask && createPortal(
        <div className="dxk-back" style={{ zIndex: 2147483000 }} onMouseDown={(e) => { if (e.target === e.currentTarget) setAsk(null); }}>
          <div className="dxc" role="alertdialog" aria-modal="true">
            <b>{ask === "reset" ? "Go back to the template?" : tpl.id && !fresh ? `Update “${tpl.name}”?` : "Save as a new template?"}</b>
            <p>{ask === "reset"
              ? "The sections and texts of this document go back to how the template has them. The values you typed for this deal stay."
              : tpl.id && !fresh ? "Every new document made from this template will start with this layout and these texts. Deal values stay as variables, so they keep filling in for each deal." : "A new template with this layout; deal values stay as variables."}</p>
            <div>
              <button type="button" className="dxb-btn" onClick={() => setAsk(null)}>Cancel</button>
              <button type="button" className="dxb-btn is-primary" onClick={ask === "reset" ? reset : toTemplate}>{ask === "reset" ? "Back to the template" : tpl.id && !fresh ? "Update template" : "Save template"}</button>
            </div>
          </div>
        </div>, document.body)}
      {from && (
        <StartFrom kind={kind} lang={tpl.lang} base={theme} trackingId={trackingId} excludeProposalId={proposal.id} offerTemplate
          templates={ofKind} onTemplate={(t) => { setFrom(false); switchTemplate(t.id); }}
          onPicked={startFrom} onClose={() => setFrom(false)} />
      )}
      {ai && (
        <AiReview blocks={inst.blocks} kind={kind} lang={tpl.lang} provider={theme.company}
          clientNames={[]}
          title={`Find values of another client left in this ${kind} and turn them into ${data.client.name || "this deal"}'s variables.`}
          onClose={() => { setAi(false); if (tplAfter) keepAsTemplate(tplAfter, inst.blocks); }}
          onApply={(blocks, summary) => { setAi(false); upd({ blocks }); setMsg({ kind: "ok", text: summary }); if (tplAfter) keepAsTemplate(tplAfter, blocks); }} />
      )}
    </>
  );
}
