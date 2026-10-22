import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useBackToClose } from "../../../framework/useBackToClose";
import {
  loadTrackingFields, addTrackingField, updateTrackingField, deleteTrackingField, reorderTrackingFields, renameTrackingValue,
  FIELD_TYPE_LABEL, type TrackingField, type TrackingFieldType,
} from "./trackingFieldsApi";
import "./TrackingFields.css";

const TYPES: TrackingFieldType[] = ["text", "number", "date", "boolean", "select"];
const TYPE_HINT: Record<TrackingFieldType, string> = {
  text: "Free text, e.g. a reference or a competitor",
  number: "A figure, e.g. licences or employees",
  date: "A date, e.g. tender deadline",
  boolean: "Yes or no, e.g. NDA signed",
  select: "One choice from your own list",
};
const TYPE_ICON: Record<TrackingFieldType, string> = {
  text: "M4 6h16M4 12h10M4 18h7",
  number: "M9 4 7 20M17 4l-2 16M4 9h16M3 15h16",
  date: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  boolean: "M9 12l2 2 4-4M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  select: "M4 7h16M4 12h16M4 17h10M18 15l2 2-2 2",
};
const norm = (s: string) => s.trim().toLowerCase();

const Ico = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const Up = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 15l6-6 6 6" /></svg>;
const Down = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>;
const X = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>;

/**
 * Deal fields: the custom fields every sales tracking can carry.
 * Leads add, rename, reorder, change type and dropdown options (each option on
 * its own line: rename, move, remove, add), mark required and delete;
 * everyone else sees the list read-only. Renaming an option renames it on
 * every deal that has it.
 */
export default function TrackingFieldsModal({ canEdit, onClose, onChanged, inline = false }: {
  canEdit: boolean;
  /** Render as a plain block (Settings › Deals page) instead of a drawer. */
  inline?: boolean;
  onClose: () => void;
  /** Called after every change, so the page can reload the definitions. */
  onChanged: (fields: TrackingField[]) => void;
}) {
  useBackToClose("sales-fields", onClose, !inline);
  const [items, setItems] = useState<TrackingField[]>([]);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [askDel, setAskDel] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // new field
  const [label, setLabel] = useState("");
  const [type, setType] = useState<TrackingFieldType>("text");
  const [required, setRequired] = useState(false);
  const [newOpts, setNewOpts] = useState<string[]>([]);
  const [optDraft, setOptDraft] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    const r = await loadTrackingFields();
    setItems(r.fields); setMissing(r.missing); setLoading(false);
    onChanged(r.fields);
  };
  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (inline) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector(".dp-pop") && !editing) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, inline, editing]);

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true); setErr(null);
    const e = await fn();
    if (e) setErr(e);
    await refresh();
    setBusy(false);
    return e;
  };

  const dup = !!label.trim() && items.some((f) => norm(f.label) === norm(label));
  const canAdd = canEdit && !!label.trim() && !dup && (type !== "select" || newOpts.length > 0);
  const addNewOpt = () => {
    const v = optDraft.trim();
    if (!v) return;
    if (newOpts.some((o) => norm(o) === norm(v))) { setOptDraft(""); return; }
    setNewOpts((xs) => [...xs, v]); setOptDraft("");
  };
  const add = () => {
    if (!canAdd) return;
    run(async () => {
      const r = await addTrackingField({ label: label.trim(), type, required, options: type === "select" ? newOpts : [], sort: items.length });
      if (!r.error) { setLabel(""); setType("text"); setRequired(false); setNewOpts([]); setOptDraft(""); nameRef.current?.focus(); }
      return r.error;
    });
  };
  const reorder = (ids: string[]) => {
    setItems(ids.map((id) => items.find((f) => f.id === id)!));
    run(() => reorderTrackingFields(ids));
  };
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const ids = items.map((f) => f.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorder(ids);
  };
  const drop = (target: string) => {
    const from = dragId; setDragId(null); setOverId(null);
    if (!from || from === target) return;
    const ids = items.map((f) => f.id).filter((id) => id !== from);
    ids.splice(ids.indexOf(target), 0, from);
    reorder(ids);
  };

  const panel = (
      <div className={`dw dw-narrow tfm${inline ? " is-inline" : ""}`} onMouseDown={(e) => e.stopPropagation()} role={inline ? undefined : "dialog"} aria-modal={inline ? undefined : true} aria-label="Deal fields">
        {!inline && <div className="dw-head">
          <div>
            <span className="dw-eyebrow">Configure</span>
            <h2 className="dw-title">Deal fields</h2>
          </div>
          <button className="dw-x" onClick={onClose} aria-label="Close">×</button>
        </div>}

        <div className="dw-body">
          <p className="tfm-where">
            Extra information every deal can carry. Fields show up when you <b>open a deal</b>,
            in each deal's <b>Details</b> card, and in <b>Reports</b> and <b>Export</b> as columns and conditions.
          </p>

          {missing && (
            <p className="tfm-note">Deal fields need the <b>tracking_fields</b> table — run <code>empower_tracking_fields.sql</code> in Supabase once.</p>
          )}
          {!canEdit && !missing && (
            <p className="tfm-note is-soft">Only the boss and sales managers can change the fields. You can fill them in on every deal.</p>
          )}

          <div className="dw-sec">
            <p className="dw-sec-title">Your fields{items.length > 0 && <span className="tfm-count">{items.length}</span>}</p>
            {loading ? (
              <p className="dw-empty-hint">Loading…</p>
            ) : items.length === 0 ? (
              <p className="tfe-empty">No deal fields yet.{canEdit && !missing ? " Add the first one below." : ""}</p>
            ) : (
              <ul className="tfe-list">
                {items.map((f, i) => editing === f.id ? (
                  <FieldEditor key={f.id} field={f} others={items.filter((x) => x.id !== f.id)}
                    onCancel={() => setEditing(null)}
                    onSave={async (patch, renames) => {
                      const e = await run(async () => {
                        const u = await updateTrackingField(f.id, patch);
                        if (u) return u;
                        for (const [from, to] of renames) { const r = await renameTrackingValue(f.id, from, to); if (r) return r; }
                        return null;
                      });
                      if (!e) setEditing(null);
                    }} />
                ) : (
                  <li key={f.id} style={{ ["--i" as string]: i } as CSSProperties}
                    className={`tfe-row ${dragId === f.id ? "is-dragging" : ""} ${overId === f.id && dragId !== f.id ? "is-over" : ""}`}
                    draggable={canEdit && !editing}
                    onDragStart={(e) => { setDragId(f.id); e.dataTransfer.effectAllowed = "move"; }}
                    onDragEnd={() => { setDragId(null); setOverId(null); }}
                    onDragOver={(e) => { if (!dragId) return; e.preventDefault(); if (overId !== f.id) setOverId(f.id); }}
                    onDrop={(e) => { e.preventDefault(); drop(f.id); }}>
                    {canEdit && (
                      <span className="tfe-move">
                        <button type="button" disabled={i === 0 || busy} onClick={() => move(i, -1)} aria-label="Move up" title="Move up"><Up /></button>
                        <button type="button" disabled={i === items.length - 1 || busy} onClick={() => move(i, 1)} aria-label="Move down" title="Move down"><Down /></button>
                      </span>
                    )}
                    <span className={`tfe-ico is-${f.type}`}><Ico d={TYPE_ICON[f.type]} /></span>
                    <span className="tfe-main">
                      <b>{f.label}</b>
                      <small>{FIELD_TYPE_LABEL[f.type]}{f.type === "select" ? ` · ${f.options.length} option${f.options.length === 1 ? "" : "s"}` : ""}</small>
                      {f.type === "select" && f.options.length > 0 && (
                        <span className="tfe-chips" title={f.options.join("\n")}>
                          {f.options.slice(0, 5).map((o) => <i key={o}>{o}</i>)}
                          {f.options.length > 5 && <i className="is-more">+{f.options.length - 5}</i>}
                        </span>
                      )}
                    </span>
                    <button type="button" role="switch" aria-checked={f.required} disabled={!canEdit || busy}
                      className={`tfe-req ${f.required ? "is-on" : ""}`} onClick={() => run(() => updateTrackingField(f.id, { required: !f.required }))}>
                      <i />Required
                    </button>
                    {canEdit && (
                      <button type="button" className="tfe-btn" onClick={() => { setEditing(f.id); setAskDel(null); }} aria-label={`Edit ${f.label}`} title="Edit name, type and options">
                        <Ico d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                      </button>
                    )}
                    {canEdit && (askDel === f.id ? (
                      <span className="tfe-ask">
                        Delete?
                        <button type="button" className="is-yes" disabled={busy} onClick={() => { setAskDel(null); run(() => deleteTrackingField(f.id)); }}>Yes</button>
                        <button type="button" onClick={() => setAskDel(null)}>No</button>
                      </span>
                    ) : (
                      <button type="button" className="tfe-btn is-del" onClick={() => setAskDel(f.id)} disabled={busy} aria-label={`Delete ${f.label}`}
                        title="Delete — deals keep the value already stored, but it won't show anymore">
                        <Ico d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
                      </button>
                    ))}
                  </li>
                ))}
              </ul>
            )}
            {canEdit && items.length > 1 && <p className="tfm-hint">Use the arrows or drag a row to change the order. The pencil edits a field's name, type and each of its options.</p>}
          </div>

          {canEdit && !missing && (
            <div className="dw-sec">
              <p className="dw-sec-title">Add a field</p>
              <div className="dw-grid">
                <div className="dw-f dw-col2"><label>Field name</label>
                  <input ref={nameRef} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Competitor, Licences, Tender deadline"
                    onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
                </div>
                <div className="dw-f dw-col2"><label>Type</label>
                  <div className="tfm-types" role="radiogroup" aria-label="Type">
                    {TYPES.map((t) => (
                      <button key={t} type="button" role="radio" aria-checked={type === t} className={type === t ? "is-on" : ""} onClick={() => setType(t)}>
                        <b><Ico d={TYPE_ICON[t]} />{FIELD_TYPE_LABEL[t]}</b><span>{TYPE_HINT[t]}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className={`tfe-newopts dw-col2 ${type === "select" ? "is-on" : ""}`}>
                  <div className="tfe-newopts-in">
                    <label className="tfe-k">Options <em>{newOpts.length}</em></label>
                    {newOpts.length > 0 && (
                      <ul className="tfe-optlist">
                        {newOpts.map((o, k) => (
                          <li key={o}>
                            <span className="tfe-mv">
                              <button type="button" disabled={k === 0} onClick={() => setNewOpts((xs) => { const c = [...xs]; [c[k - 1], c[k]] = [c[k], c[k - 1]]; return c; })} aria-label="Move up"><Up /></button>
                              <button type="button" disabled={k === newOpts.length - 1} onClick={() => setNewOpts((xs) => { const c = [...xs]; [c[k + 1], c[k]] = [c[k], c[k + 1]]; return c; })} aria-label="Move down"><Down /></button>
                            </span>
                            <input value={o} tabIndex={type === "select" ? 0 : -1}
                              onChange={(e) => { const v = e.target.value; setNewOpts((xs) => xs.map((x, j) => (j === k ? v : x))); }}
                              onBlur={() => setNewOpts((xs) => xs.map((x) => x.trim()).filter(Boolean))} />
                            <button type="button" className="tfe-x" onClick={() => setNewOpts((xs) => xs.filter((_, j) => j !== k))} aria-label={`Remove ${o}`}><X /></button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="tfe-optadd">
                      <input value={optDraft} placeholder="Type an option and press Enter — e.g. Inbound" tabIndex={type === "select" ? 0 : -1}
                        onChange={(e) => setOptDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addNewOpt(); } }} />
                      <button type="button" onClick={addNewOpt} disabled={!optDraft.trim()} tabIndex={type === "select" ? 0 : -1}>+ Add option</button>
                    </div>
                  </div>
                </div>
                <div className="dw-f dw-col2 tfm-reqline">
                  <button type="button" role="switch" aria-checked={required}
                    className={`dw-switch ${required ? "on" : ""}`} onClick={() => setRequired((v) => !v)}>
                    <span className="dw-switch-knob" />
                  </button>
                  <span><b>Required</b> · a deal can't be opened without it</span>
                </div>
              </div>
              {dup && <p className="dw-err">There's already a field called “{label.trim()}”.</p>}
              {type === "select" && label.trim() && !newOpts.length && <p className="tfm-hint">Add at least one option for a dropdown.</p>}
              <button className="dw-save cf-add" onClick={add} disabled={busy || !canAdd}>{busy ? "Saving…" : "+ Add field"}</button>
            </div>
          )}
          {err && <p className="dw-err">{err}</p>}
        </div>

        {!inline && <div className="dw-foot">
          <div className="dw-foot-right">
            <button className="dw-save" onClick={onClose}>Done</button>
          </div>
        </div>}
      </div>
  );
  if (inline) return panel;
  return (
    <div className="dw-backdrop tfm-backdrop" onMouseDown={onClose}>
      {panel}
    </div>
  );
}

/** One deal field opened for editing: name, type and — for dropdowns — each option on its own line. */
function FieldEditor({ field, others, onCancel, onSave }: {
  field: TrackingField; others: TrackingField[];
  onCancel: () => void;
  onSave: (patch: { label: string; type: TrackingFieldType; options: string[] }, renames: [string, string][]) => Promise<void>;
}) {
  const [label, setLabel] = useState(field.label);
  const [type, setType] = useState<TrackingFieldType>(field.type);
  // each option remembers its name when the editor opened, so a rename moves the stored values
  const [opts, setOpts] = useState<{ k: number; was: string | null; v: string }[]>(() => field.options.map((o, k) => ({ k, was: o, v: o })));
  const [newOpt, setNewOpt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nextK = useRef(field.options.length + 1);
  const addOpt = () => {
    const v = newOpt.trim();
    if (!v) return;
    if (opts.some((o) => norm(o.v) === norm(v))) { setErr(`“${v}” is already an option.`); return; }
    setOpts((xs) => [...xs, { k: nextK.current++, was: null, v }]); setNewOpt(""); setErr(null);
  };
  const moveOpt = (i: number, d: number) => setOpts((xs) => {
    const j = i + d; if (j < 0 || j >= xs.length) return xs;
    const c = [...xs]; [c[i], c[j]] = [c[j], c[i]]; return c;
  });
  const save = async () => {
    const l = label.trim();
    if (!l) { setErr("The field needs a name."); return; }
    if (norm(l) !== norm(field.label) && others.some((f) => norm(f.label) === norm(l))) { setErr(`There is already a field called “${l}”.`); return; }
    const clean = opts.map((o) => ({ ...o, v: o.v.trim() })).filter((o) => o.v);
    const seen = new Set<string>();
    for (const o of clean) { if (seen.has(norm(o.v))) { setErr(`“${o.v}” is in the list twice.`); return; } seen.add(norm(o.v)); }
    if (type === "select" && !clean.length) { setErr("Add at least one option."); return; }
    setBusy(true); setErr(null);
    const renames: [string, string][] = type === "select" ? clean.filter((o) => o.was && o.was !== o.v).map((o) => [o.was!, o.v]) : [];
    await onSave({ label: l, type, options: type === "select" ? clean.map((o) => o.v) : [] }, renames);
    setBusy(false);
  };
  const renamed = opts.filter((o) => o.was && o.v.trim() && o.was !== o.v.trim()).length;
  return (
    <li className="tfe-row is-editing">
      <div className="tfe-ed">
        <label className="tfe-f">
          <span className="tfe-k">Name</span>
          <input value={label} autoFocus onChange={(e) => { setLabel(e.target.value); setErr(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }} />
        </label>
        <div className="tfe-f">
          <span className="tfe-k">Type</span>
          <div className="tfe-typeseg" role="radiogroup" aria-label="Type">
            {TYPES.map((t) => (
              <button key={t} type="button" role="radio" aria-checked={type === t} className={type === t ? "is-on" : ""} onClick={() => { setType(t); setErr(null); }}>
                <Ico d={TYPE_ICON[t]} />{FIELD_TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        </div>
        {type !== field.type && <p className="tfe-warn">Values already saved on deals stay as they are; ones that don't fit the new type may show empty.</p>}
        {type === "select" && (
          <div className="tfe-f">
            <span className="tfe-k">Options <em>{opts.length}</em></span>
            <ul className="tfe-optlist">
              {opts.map((o, i) => (
                <li key={o.k}>
                  <span className="tfe-mv">
                    <button type="button" disabled={i === 0} onClick={() => moveOpt(i, -1)} aria-label="Move up"><Up /></button>
                    <button type="button" disabled={i === opts.length - 1} onClick={() => moveOpt(i, 1)} aria-label="Move down"><Down /></button>
                  </span>
                  <input value={o.v} onChange={(e) => { const v = e.target.value; setOpts((xs) => xs.map((x) => (x.k === o.k ? { ...x, v } : x))); setErr(null); }}
                    onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }} />
                  {o.was && o.was !== o.v.trim() && o.v.trim() && <small className="tfe-was" title="Deals with the old value get the new one">was “{o.was}”</small>}
                  {!o.was && <small className="tfe-was is-new">new</small>}
                  <button type="button" className="tfe-x" onClick={() => setOpts((xs) => xs.filter((x) => x.k !== o.k))} aria-label={`Remove ${o.v}`} title="Remove — deals keep the old value">
                    <X />
                  </button>
                </li>
              ))}
            </ul>
            <div className="tfe-optadd">
              <input value={newOpt} placeholder="Add an option…" onChange={(e) => { setNewOpt(e.target.value); setErr(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addOpt(); } }} />
              <button type="button" onClick={addOpt} disabled={!newOpt.trim()}>+ Add option</button>
            </div>
          </div>
        )}
        {err && <p className="dw-err">{err}</p>}
        <div className="tfe-foot">
          {renamed > 0 && <span className="tfe-foot-note">{renamed} renamed option{renamed === 1 ? "" : "s"} will be updated on every deal.</span>}
          <button type="button" className="tfe-cancel" onClick={onCancel}>Cancel</button>
          <button type="button" className="dw-save" onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save field"}</button>
        </div>
      </div>
    </li>
  );
}
