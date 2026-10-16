/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Settings → Tasks
 *
 *   1. Quick → process: a quick task still open after N days turns into a
 *      process (status, % and progress notes), so long-running work doesn't
 *      hide in the quick list.
 *   2. Predefined tasks and processes: the ones the team creates again and
 *      again — name, description, priority, a deadline rule ("3 days after
 *      it's made, at 18:00") and, for a process, its steps. They're offered
 *      from the ✦ button wherever a task is added (Home, the task window, deals).
 *
 * The boss, managers and superadmins can change them (the database checks
 * too); everyone else sees them read-only.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import TimePicker from "../../framework/TimePicker";
import {
  loadTaskSettings, saveTaskSettings, loadTaskTemplates, saveTaskTemplate, deleteTaskTemplate,
  TASK_PRIORITIES, DEFAULT_TASK_SETTINGS,
  type TaskSettings as Settings, type TaskTemplate, type TaskPriority, type TaskKind,
} from "../sales/sales/salesApi";
import { FlagIcon, PRIORITY_LABEL } from "../homepage/shared/HomeTodo";
import "../homepage/shared/HomeShared.css";

type Filter = "all" | TaskKind;
type Draft = Omit<TaskTemplate, "id"> & { id?: string };
const EMPTY: Draft = { kind: "quick", title: "", description: "", priority: "normal", due_in_days: null, due_time: "18:00", checklist: [], sort: 0 };
const DAY_PICKS = [3, 5, 7, 14, 30];

const dueRule = (t: { due_in_days: number | null; due_time: string }) =>
  t.due_in_days == null ? "No deadline"
    : t.due_in_days === 0 ? `Due the same day · ${t.due_time}`
    : t.due_in_days === 1 ? `Due the next day · ${t.due_time}`
    : `Due ${t.due_in_days} days later · ${t.due_time}`;

const StepsIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" /></svg>
);
const ClockIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
);

export default function TaskSettings({ onBack, canManage }: { onBack: () => void; canManage: boolean }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_TASK_SETTINGS);
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [editing, setEditing] = useState<Draft | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    Promise.all([loadTaskSettings(true), loadTaskTemplates()]).then(([s, t]) => {
      if (!alive) return;
      setSettings(s); setTemplates(t); setLoading(false);
    });
    return () => { alive = false; window.clearTimeout(saveTimer.current); };
  }, []);

  // The rule saves itself a moment after you stop changing it.
  const changeRule = (patch: Partial<Settings>) => {
    if (!canManage) return;
    const next = { ...settings, ...patch };
    setSettings(next); setSaved("saving");
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const e = await saveTaskSettings(next);
      setSaved(e ? "error" : "saved"); setErr(e);
      if (!e) window.setTimeout(() => setSaved((s) => (s === "saved" ? "idle" : s)), 1800);
    }, 500);
  };

  const shown = useMemo(() => templates.filter((t) => filter === "all" || t.kind === filter), [templates, filter]);
  const counts = { all: templates.length, quick: templates.filter((t) => t.kind === "quick").length, process: templates.filter((t) => t.kind === "process").length };

  const onSaved = (t: TaskTemplate) => setTemplates((xs) => (xs.some((x) => x.id === t.id) ? xs.map((x) => (x.id === t.id ? t : x)) : [...xs, t]));
  const onDeleted = (id: string) => setTemplates((xs) => xs.filter((x) => x.id !== id));

  const days = settings.auto_process_days;
  return (
    <div className="st ts">
      <header className="st-bar st-bar-row">
        <button className="st-back" onClick={onBack} aria-label="Back">‹</button>
        <div>
          <h1 className="st-title">Tasks</h1>
          <p className="st-sub">How tasks behave, and the ones your team uses again and again</p>
        </div>
        {!canManage && <span className="ts-readonly">Only the boss and managers can change these</span>}
      </header>

      {/* ---------- quick → process ---------- */}
      <section className={`ts-rule ${settings.auto_process_on ? "is-on" : ""} ${loading ? "is-loading" : ""}`}>
        <div className="ts-rule-text">
          <span className="ts-kicker">Automatic</span>
          <h2>Quick tasks that drag on become processes</h2>
          <p>A quick task is meant to be ticked off soon. If it's still open after a while, it turns into a <b>process</b> — so it gets a status, a % and progress notes, and stops hiding in the quick list.</p>
          <div className="ts-rule-ctl">
            <button className={`ts-switch ${settings.auto_process_on ? "is-on" : ""}`} role="switch" aria-checked={settings.auto_process_on}
              disabled={!canManage} onClick={() => changeRule({ auto_process_on: !settings.auto_process_on })}>
              <i />
            </button>
            <span className="ts-switch-lbl">{settings.auto_process_on ? "On" : "Off"}</span>
            <span className={`ts-saved is-${saved}`} aria-live="polite">
              {saved === "saving" ? "Saving…" : saved === "saved" ? "Saved ✓" : saved === "error" ? err : ""}
            </span>
          </div>
          <div className="ts-days" aria-disabled={!settings.auto_process_on}>
            <span className="ts-days-lbl">After</span>
            <div className="ts-stepper">
              <button onClick={() => changeRule({ auto_process_days: Math.max(1, days - 1) })} disabled={!canManage || days <= 1} aria-label="One day less">−</button>
              <b key={days}>{days}</b>
              <button onClick={() => changeRule({ auto_process_days: Math.min(365, days + 1) })} disabled={!canManage || days >= 365} aria-label="One day more">+</button>
            </div>
            <span className="ts-days-lbl">{days === 1 ? "day open" : "days open"}</span>
            <div className="ts-day-picks">
              {DAY_PICKS.map((d) => (
                <button key={d} className={days === d ? "is-on" : ""} disabled={!canManage} onClick={() => changeRule({ auto_process_days: d })}>{d}d</button>
              ))}
            </div>
          </div>
        </div>

        {/* the picture: a quick task travelling along the days until it becomes a process */}
        <div className="ts-rule-art" aria-hidden="true" style={{ ["--n" as string]: Math.min(days, 14) } as React.CSSProperties}>
          <div className="ts-track">
            {Array.from({ length: Math.min(days, 14) + 1 }).map((_, i) => <i key={i} style={{ left: `${(i / Math.min(days, 14)) * 100}%` }} />)}
          </div>
          <div className="ts-traveller">
            <span className="ts-chip is-quick"><FlagIcon />Quick task</span>
            <span className="ts-chip is-process"><StepsIcon />Process · 0%</span>
          </div>
          <div className="ts-track-lbls"><span>Created</span><span>Day {days}</span></div>
        </div>
      </section>

      {/* ---------- predefined ---------- */}
      <section className="ts-tpl">
        <div className="ts-tpl-head">
          <div>
            <span className="ts-kicker">Predefined</span>
            <h2>Tasks &amp; processes you use again and again</h2>
            <p>Offered from the <span className="ts-spark">✦</span> button wherever a task is added. Picking one fills in the name, description, priority, deadline and steps.</p>
          </div>
          <div className="ts-tpl-tools">
            <div className="ts-filter" role="tablist">
              {(["all", "quick", "process"] as Filter[]).map((f) => (
                <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? "is-on" : ""} onClick={() => setFilter(f)}>
                  {f === "all" ? "All" : f === "quick" ? "Quick tasks" : "Processes"}<em>{counts[f]}</em>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="ts-grid">
          {canManage && (
            <button className="ts-card ts-new" onClick={() => setEditing({ ...EMPTY, kind: filter === "process" ? "process" : "quick", sort: templates.length })}>
              <span className="ts-new-plus">+</span>
              <b>New {filter === "process" ? "process" : filter === "quick" ? "quick task" : "template"}</b>
              <small>Name, priority, deadline{filter !== "quick" ? " and steps" : ""}</small>
            </button>
          )}
          {loading ? [0, 1, 2].map((i) => <div key={i} className="ts-card ts-skel" />) : shown.map((t, i) => (
            <button key={t.id} className={`ts-card is-${t.kind} is-p-${t.priority}`} style={{ ["--i" as string]: i } as React.CSSProperties}
              onClick={() => setEditing({ ...t })}>
              <div className="ts-card-top">
                <span className={`ts-kind is-${t.kind}`}>{t.kind === "process" ? <><StepsIcon />Process</> : <><FlagIcon />Quick task</>}</span>
                {t.priority !== "normal" && <span className={`hs-prio is-${t.priority}`}><FlagIcon /><span>{PRIORITY_LABEL[t.priority]}</span></span>}
              </div>
              <b className="ts-card-title">{t.title}</b>
              {t.description && <p className="ts-card-desc">{t.description}</p>}
              {t.checklist.length > 0 && (
                <ol className="ts-card-steps">
                  {t.checklist.slice(0, 4).map((s, j) => <li key={j}><i>{j + 1}</i>{s}</li>)}
                  {t.checklist.length > 4 && <li className="is-more">+{t.checklist.length - 4} more steps</li>}
                </ol>
              )}
              <div className="ts-card-foot">
                <span><ClockIcon />{dueRule(t)}</span>
                {t.checklist.length > 0 && <span><StepsIcon />{t.checklist.length} steps</span>}
              </div>
            </button>
          ))}
          {!loading && shown.length === 0 && !canManage && <p className="ts-none">No predefined {filter === "process" ? "processes" : "tasks"} yet.</p>}
        </div>
      </section>

      {editing && (
        <TemplateEditor draft={editing} canManage={canManage} onClose={() => setEditing(null)}
          onSaved={(t) => { onSaved(t); setEditing(null); }} onDeleted={(id) => { onDeleted(id); setEditing(null); }} />
      )}
    </div>
  );
}

/* ============================ Editor ============================ */
function TemplateEditor({ draft, canManage, onClose, onSaved, onDeleted }: {
  draft: Draft; canManage: boolean; onClose: () => void; onSaved: (t: TaskTemplate) => void; onDeleted: (id: string) => void;
}) {
  const [d, setD] = useState<Draft>({ ...draft, checklist: [...draft.checklist] });
  const [newStep, setNewStep] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const ro = !canManage;

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);

  const addStep = () => { const t = newStep.trim(); if (!t) return; set({ checklist: [...d.checklist, t] }); setNewStep(""); };
  const moveStep = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= d.checklist.length) return;
    const list = [...d.checklist]; [list[i], list[j]] = [list[j], list[i]]; set({ checklist: list });
  };
  const save = async () => {
    if (!d.title.trim()) { setErr("Give it a name."); return; }
    setSaving(true); setErr(null);
    const { template, error } = await saveTaskTemplate({ ...d, checklist: newStep.trim() ? [...d.checklist, newStep.trim()] : d.checklist });
    setSaving(false);
    if (error || !template) { setErr(error ?? "Not saved."); return; }
    onSaved(template);
  };
  const remove = async () => {
    if (!d.id) return;
    const e = await deleteTaskTemplate(d.id);
    if (e) { setErr(e); return; }
    onDeleted(d.id);
  };

  // What a task made from it today would look like.
  const preview = (() => {
    if (d.due_in_days == null) return null;
    const x = new Date(); x.setDate(x.getDate() + d.due_in_days);
    return `${x.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })} at ${d.due_time}`;
  })();

  return createPortal(
    <div className="tse-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`tse is-${d.kind} is-p-${d.priority}`} role="dialog" aria-modal="true" aria-label="Predefined task">
        <header className="tse-head">
          <div className="tse-kind" role="radiogroup" aria-label="Kind">
            {(["quick", "process"] as TaskKind[]).map((k) => (
              <button key={k} role="radio" aria-checked={d.kind === k} className={d.kind === k ? "is-on" : ""} disabled={ro} onClick={() => set({ kind: k })}>
                {k === "quick" ? <><FlagIcon />Quick task</> : <><StepsIcon />Process</>}
              </button>
            ))}
          </div>
          <button className="tse-x" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="tse-body">
          <label className="tse-field">
            <span>Name</span>
            <input value={d.title} onChange={(e) => set({ title: e.target.value })} readOnly={ro} autoFocus={!ro}
              placeholder={d.kind === "process" ? "e.g. Onboard a new client" : "e.g. Send the NDA"} />
          </label>
          <label className="tse-field">
            <span>Description</span>
            <textarea value={d.description ?? ""} onChange={(e) => set({ description: e.target.value })} readOnly={ro} rows={3}
              placeholder="What it's for, what done looks like, links…" />
          </label>

          <div className="tse-field">
            <span>Priority</span>
            <div className="tse-prios">
              {TASK_PRIORITIES.map((p) => (
                <button key={p} className={`hs-prio is-${p} ${d.priority === p ? "is-on" : ""}`} disabled={ro} onClick={() => set({ priority: p as TaskPriority })}>
                  <FlagIcon /><span>{PRIORITY_LABEL[p]}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="tse-field">
            <span>Deadline</span>
            <div className="tse-due">
              <button className={`ts-switch is-sm ${d.due_in_days != null ? "is-on" : ""}`} role="switch" aria-checked={d.due_in_days != null} disabled={ro}
                onClick={() => set({ due_in_days: d.due_in_days == null ? 2 : null })}><i /></button>
              {d.due_in_days == null ? <em>No deadline</em> : (
                <>
                  <span>Due</span>
                  <div className="ts-stepper is-sm">
                    <button disabled={ro || d.due_in_days <= 0} onClick={() => set({ due_in_days: Math.max(0, (d.due_in_days ?? 0) - 1) })}>−</button>
                    <b key={d.due_in_days}>{d.due_in_days}</b>
                    <button disabled={ro || d.due_in_days >= 365} onClick={() => set({ due_in_days: Math.min(365, (d.due_in_days ?? 0) + 1) })}>+</button>
                  </div>
                  <span>{d.due_in_days === 1 ? "day" : "days"} after it's created, at</span>
                  <TimePicker value={d.due_time} onChange={(v) => set({ due_time: v || "18:00" })} ariaLabel="Due time" />
                </>
              )}
            </div>
            {preview && <small className="tse-preview">Made today, it would be due <b>{preview}</b>.</small>}
          </div>

          {(d.kind === "process" || d.checklist.length > 0) && (
            <div className="tse-field">
              <span>Steps {d.checklist.length > 0 && <em className="tse-count">{d.checklist.length}</em>}</span>
              <ol className="tse-steps">
                {d.checklist.map((s, i) => (
                  <li key={i} style={{ ["--i" as string]: i } as React.CSSProperties}>
                    <i>{i + 1}</i>
                    <input value={s} readOnly={ro} onChange={(e) => set({ checklist: d.checklist.map((x, j) => (j === i ? e.target.value : x)) })} />
                    {!ro && (
                      <span className="tse-step-tools">
                        <button onClick={() => moveStep(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                        <button onClick={() => moveStep(i, 1)} disabled={i === d.checklist.length - 1} aria-label="Move down">↓</button>
                        <button className="is-x" onClick={() => set({ checklist: d.checklist.filter((_, j) => j !== i) })} aria-label="Remove">×</button>
                      </span>
                    )}
                  </li>
                ))}
              </ol>
              {!ro && (
                <div className="tse-step-add">
                  <span>+</span>
                  <input value={newStep} onChange={(e) => setNewStep(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addStep(); }}
                    placeholder={d.checklist.length ? "Add another step…" : "First step — e.g. Kick-off call"} />
                  {newStep.trim() && <button onClick={addStep}>Add</button>}
                </div>
              )}
              <small className="tse-preview">Ticking the steps moves the process's %.</small>
            </div>
          )}
        </div>

        <footer className="tse-foot">
          {err && <span className="tse-err">{err}</span>}
          {!ro && d.id && (confirmDel ? (
            <span className="tse-confirm">Delete it? <button className="tse-btn is-danger" onClick={remove}>Delete</button><button className="tse-btn" onClick={() => setConfirmDel(false)}>Keep</button></span>
          ) : <button className="tse-del" onClick={() => setConfirmDel(true)}>Delete</button>)}
          <span className="tse-spacer" />
          <button className="tse-btn" onClick={onClose}>{ro ? "Close" : "Cancel"}</button>
          {!ro && <button className="tse-btn is-primary" onClick={save} disabled={saving || !d.title.trim()}>{saving ? "Saving…" : d.id ? "Save changes" : "Create"}</button>}
        </footer>
      </div>
    </div>,
    document.body,
  );
}