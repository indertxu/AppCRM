import { useEffect, useRef, useState } from "react";
import { useBackToClose } from "../../../framework/useBackToClose";
import {
  loadTrackingFields, addTrackingField, updateTrackingField, deleteTrackingField, reorderTrackingFields,
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
const splitOptions = (s: string) => Array.from(new Set(s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)));

/**
 * Deal fields: the custom fields every sales tracking can carry.
 * Same drawer as Contact / Company fields. Leads can add, rename, reorder,
 * change dropdown options, mark required and delete; everyone else sees the
 * list read-only.
 */
export default function TrackingFieldsModal({ canEdit, onClose, onChanged }: {
  canEdit: boolean;
  onClose: () => void;
  /** Called after every change, so the page can reload the definitions. */
  onChanged: (fields: TrackingField[]) => void;
}) {
  useBackToClose("sales-fields", onClose);
  const [items, setItems] = useState<TrackingField[]>([]);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [type, setType] = useState<TrackingFieldType>("text");
  const [required, setRequired] = useState(false);
  const [optionsText, setOptionsText] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [optsFor, setOptsFor] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    const r = await loadTrackingFields();
    setItems(r.fields); setMissing(r.missing); setLoading(false);
    onChanged(r.fields);
  };
  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector(".dp-pop")) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true); setErr(null);
    const e = await fn();
    if (e) setErr(e);
    await refresh();
    setBusy(false);
  };

  const options = splitOptions(optionsText);
  const canAdd = canEdit && !!label.trim() && (type !== "select" || options.length > 0)
    && !items.some((f) => f.label.trim().toLowerCase() === label.trim().toLowerCase());
  const add = () => {
    if (!canAdd) return;
    run(async () => {
      const r = await addTrackingField({ label: label.trim(), type, required, options: type === "select" ? options : [], sort: items.length });
      if (!r.error) { setLabel(""); setType("text"); setRequired(false); setOptionsText(""); nameRef.current?.focus(); }
      return r.error;
    });
  };
  const rename = (f: TrackingField, v: string) => {
    setRenaming(null);
    const next = v.trim();
    if (!next || next === f.label) return;
    run(() => updateTrackingField(f.id, { label: next }));
  };
  const saveOptions = (f: TrackingField, text: string) => {
    setOptsFor(null);
    const next = splitOptions(text);
    if (!next.length || JSON.stringify(next) === JSON.stringify(f.options)) return;
    run(() => updateTrackingField(f.id, { options: next }));
  };
  const remove = (f: TrackingField) => {
    if (!window.confirm(`Delete “${f.label}”? Deals keep the value already stored, but it won't show anymore.`)) return;
    run(() => deleteTrackingField(f.id));
  };
  const drop = (target: string) => {
    const from = dragId; setDragId(null); setOverId(null);
    if (!from || from === target) return;
    const ids = items.map((f) => f.id).filter((id) => id !== from);
    ids.splice(ids.indexOf(target), 0, from);
    setItems(ids.map((id) => items.find((f) => f.id === id)!));
    run(() => reorderTrackingFields(ids));
  };

  return (
    <div className="dw-backdrop tfm-backdrop" onMouseDown={onClose}>
      <div className="dw dw-narrow tfm" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Deal fields">
        <div className="dw-head">
          <div>
            <span className="dw-eyebrow">Configure</span>
            <h2 className="dw-title">Deal fields</h2>
          </div>
          <button className="dw-x" onClick={onClose} aria-label="Close">×</button>
        </div>

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
              <p className="dw-empty-hint">No deal fields yet.{canEdit && !missing ? " Add the first one below." : ""}</p>
            ) : (
              <div className="cf-list tfm-list">
                {items.map((f) => (
                  <div key={f.id}
                    className={`cf-row tfm-row ${dragId === f.id ? "is-dragging" : ""} ${overId === f.id && dragId !== f.id ? "is-over" : ""}`}
                    draggable={canEdit && renaming !== f.id && optsFor !== f.id}
                    onDragStart={(e) => { setDragId(f.id); e.dataTransfer.effectAllowed = "move"; }}
                    onDragEnd={() => { setDragId(null); setOverId(null); }}
                    onDragOver={(e) => { if (!dragId) return; e.preventDefault(); if (overId !== f.id) setOverId(f.id); }}
                    onDrop={(e) => { e.preventDefault(); drop(f.id); }}>
                    {canEdit && <span className="tfm-grip" aria-hidden="true">⋮⋮</span>}
                    <div className="cf-row-main">
                      {renaming === f.id ? (
                        <input className="tfm-rename" autoFocus defaultValue={f.label}
                          onBlur={(e) => rename(f, e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { e.stopPropagation(); setRenaming(null); } }} />
                      ) : (
                        <button type="button" className="cf-row-name tfm-name" disabled={!canEdit} onClick={() => setRenaming(f.id)}
                          title={canEdit ? "Click to rename" : undefined}>{f.label}</button>
                      )}
                      <span className="cf-row-type">
                        {FIELD_TYPE_LABEL[f.type]}
                        {f.type === "select" && (
                          <> · {canEdit
                            ? <button type="button" className="tfm-optlink" onClick={() => setOptsFor(optsFor === f.id ? null : f.id)}>{f.options.length} {f.options.length === 1 ? "option" : "options"}</button>
                            : `${f.options.length} ${f.options.length === 1 ? "option" : "options"}`}</>
                        )}
                      </span>
                      {f.type === "select" && optsFor !== f.id && f.options.length > 0 && (
                        <span className="tfm-chips">{f.options.slice(0, 8).map((o) => <i key={o}>{o}</i>)}{f.options.length > 8 && <i>+{f.options.length - 8}</i>}</span>
                      )}
                      {optsFor === f.id && (
                        <div className="tfm-opts">
                          <textarea autoFocus rows={3} defaultValue={f.options.join(", ")} aria-label="Options"
                            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setOptsFor(null); } if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.target as HTMLTextAreaElement).blur(); }}
                            onBlur={(e) => saveOptions(f, e.target.value)} />
                          <span>Separate options with commas or new lines. Deals keep a value you remove.</span>
                        </div>
                      )}
                    </div>
                    <button type="button" role="switch" aria-checked={f.required} disabled={!canEdit || busy}
                      className={`cf-req ${f.required ? "on" : ""}`} onClick={() => run(() => updateTrackingField(f.id, { required: !f.required }))}>Required</button>
                    {canEdit && <button className="cf-del" onClick={() => remove(f)} disabled={busy} aria-label={`Delete ${f.label}`}>×</button>}
                  </div>
                ))}
              </div>
            )}
            {canEdit && items.length > 1 && <p className="tfm-hint">Drag to change the order they're shown in. Click a name to rename it.</p>}
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
                        <b>{FIELD_TYPE_LABEL[t]}</b><span>{TYPE_HINT[t]}</span>
                      </button>
                    ))}
                  </div>
                </div>
                {type === "select" && (
                  <div className="dw-f dw-col2"><label>Options</label>
                    <textarea className="dw-area" rows={2} value={optionsText} onChange={(e) => setOptionsText(e.target.value)} placeholder="e.g. Inbound, Referral, Event, Outbound" />
                    {options.length > 0 && <span className="tfm-chips">{options.map((o) => <i key={o}>{o}</i>)}</span>}
                  </div>
                )}
                <div className="dw-f dw-col2 tfm-reqline">
                  <button type="button" role="switch" aria-checked={required}
                    className={`dw-switch ${required ? "on" : ""}`} onClick={() => setRequired((v) => !v)}>
                    <span className="dw-switch-knob" />
                  </button>
                  <span><b>Required</b> · a deal can't be opened without it</span>
                </div>
              </div>
              {label.trim() && items.some((f) => f.label.trim().toLowerCase() === label.trim().toLowerCase()) && (
                <p className="dw-err">There's already a field called “{label.trim()}”.</p>
              )}
              <button className="dw-save cf-add" onClick={add} disabled={busy || !canAdd}>{busy ? "Saving…" : "+ Add field"}</button>
            </div>
          )}
          {err && <p className="dw-err">{err}</p>}
        </div>

        <div className="dw-foot">
          <div className="dw-foot-right">
            <button className="dw-save" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}

