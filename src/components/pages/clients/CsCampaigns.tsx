/* eslint-disable @typescript-eslint/no-explicit-any */
/* =====================================================================
   Customer success › Automatic e-mails › Campaigns & sequences, in the modern look
   (light canvas, white cards with big radii, a deep pine and a neon lime figure,
   icons in circles) — and the report of each one: how many got it, opened it,
   clicked, replied, when, who, per client, per version, per e-mail.
   Reads cs_email_log (88_cs_followups.sql + 114_cs_flows.sql: opened_at, opens,
   clicked_at, clicks, replied_at, variant, node).
   ===================================================================== */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../api/supabase";
import { downloadBlob, tableToXlsx, type ExportCell } from "../../framework/exportFile";
import type { CsMailLog, CsRun, CsSequence, CsTemplate } from "./useClientsData";
import "./CsCampaigns.css";

const P: Record<string, string> = {
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4z",
  mail: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  click: "M9 9l5 12 1.8-5.2L21 14zM7.2 2.2 8 5.1M5.1 8l-2.9-.8M14 4.1 12 6.2M6.2 12l-2.1 2",
  reply: "M9 17l-5-5 5-5M4 12h11a5 5 0 0 1 5 5v2",
  alert: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  users: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  repeat: "m17 1 4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3",
  trash: "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14",
  edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  x: "M6 6l12 12M18 6L6 18",
  arrow: "M5 12h14M13 6l6 6-6 6",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  down: "M12 3v12M6 11l6 6 6-6M4 21h16",
  refresh: "M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  layers: "M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  check: "M20 6 9 17l-5-5",
  play: "M5 3l14 9-14 9z",
  building: "M3 21h18M5 21V7l7-4 7 4v14M9 9h1M14 9h1M9 13h1M14 13h1M9 17h1M14 17h1",
};
const Ico = ({ n, s = 16 }: { n: keyof typeof P; s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={P[n]} /></svg>
);

export interface CcClient { id: string; name: string; contacts: { name?: string; email?: string }[] }
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const ms = (d: string | null | undefined) => (d ? new Date(d).getTime() : NaN);
const dShort = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—");
const dTime = (d: string | null | undefined) => (d ? new Date(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "");
const dFull = (d: string | null | undefined) => (d ? `${new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} · ${dTime(d)}` : "—");
/** how long after it went out: "4 min", "2 h", "3 d" */
const after = (a: string | null | undefined, b: string | null | undefined) => {
  const m = (ms(b) - ms(a)) / 60000;
  if (!Number.isFinite(m) || m < 0) return "";
  return m < 1 ? "< 1 min" : m < 60 ? `${Math.round(m)} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};
/** an open in the first minute (or a click at the very moment it opened): most often a mail filter checking the e-mail, not a person */
export const ccAuto = (l: CsMailLog) => !!l.opened_at && (ms(l.opened_at) - ms(l.sent_at) < 60_000 || (!!l.clicked_at && Math.abs(ms(l.clicked_at) - ms(l.opened_at)) < 1500 && ms(l.opened_at) - ms(l.sent_at) < 5 * 60_000));

type Stage = "failed" | "skipped" | "replied" | "clicked" | "opened" | "sent";
const stageOf = (l: CsMailLog, noAuto: boolean): Stage => {
  if (l.status === "failed") return "failed";
  if (l.status === "skipped") return "skipped";
  if (l.replied_at) return "replied";
  const bot = noAuto && ccAuto(l);
  if (l.clicked_at && !bot) return "clicked";
  if (l.opened_at && !bot) return "opened";
  return "sent";
};
const STAGE_LABEL: Record<Stage, string> = { failed: "Failed", skipped: "Skipped", replied: "Replied", clicked: "Clicked", opened: "Opened", sent: "Not opened" };

interface Stats { sent: number; opened: number; clicked: number; replied: number; failed: number; skipped: number; auto: number }
function statsOf(rows: CsMailLog[], noAuto = false): Stats {
  const s: Stats = { sent: 0, opened: 0, clicked: 0, replied: 0, failed: 0, skipped: 0, auto: 0 };
  for (const l of rows) {
    if (l.status === "failed") { s.failed++; continue; }
    if (l.status === "skipped") { s.skipped++; continue; }
    if (l.status !== "sent") continue;
    s.sent++;
    const bot = ccAuto(l);
    if (bot) s.auto++;
    const st = stageOf(l, noAuto);
    if (st === "replied" || st === "clicked" || st === "opened") s.opened++;
    if (st === "replied" ? !!l.clicked_at && !(noAuto && bot) : st === "clicked") s.clicked++;
    if (st === "replied") s.replied++;
  }
  return s;
}

/* =====================================================================
   The board: figures for the last 30 days, then one card per campaign / sequence
   ===================================================================== */
export function CsCampaignBoard({ sequences, runs, log, templates, clients, peopleName, audience, reach, sending, kind, setKind,
  onEdit, onSend, onCopy, onDelete, onToggle, onOpenClient, empty }: {
  sequences: CsSequence[]; runs: CsRun[]; log: CsMailLog[]; templates: CsTemplate[]; clients: CcClient[];
  peopleName: (id: string | null | undefined) => string;
  audience: (q: CsSequence) => string; reach: (q: CsSequence) => { clients: number; people: number };
  sending: string | null; kind: "all" | "campaign" | "sequence"; setKind: (k: "all" | "campaign" | "sequence") => void;
  onEdit: (q: CsSequence) => void; onSend: (q: CsSequence) => void; onCopy: (q: CsSequence) => void; onDelete: (q: CsSequence) => void;
  onToggle: (q: CsSequence) => void; onOpenClient: (id: string) => void; empty: ReactNode;
}) {
  const [rep, setRep] = useState<string | null>(null);
  const since = Date.now() - 30 * 864e5;
  const recent = log.filter((l) => l.sequence_id && ms(l.sent_at) > since);
  const s30 = statsOf(recent, true);
  const clients30 = new Set(recent.filter((l) => l.status === "sent").map((l) => l.client_id)).size;
  const tplName = (id: string | null | undefined) => templates.find((t) => t.id === id)?.name ?? "—";
  const isCamp = (q: CsSequence) => q.kind === "campaign";
  const shown = sequences.filter((q) => kind === "all" || (kind === "campaign" ? isCamp(q) : !isCamp(q)))
    // what's going on first: sending, then the latest sent, then what's on, then drafts
    .map((q) => ({ q, at: Math.max(ms(q.launched_at) || 0, ...log.filter((l) => l.sequence_id === q.id).slice(0, 1).map((l) => ms(l.sent_at))) }))
    .sort((a, b) => (b.at || 0) - (a.at || 0) || String(b.q.created_at ?? "").localeCompare(String(a.q.created_at ?? "")))
    .map((x) => x.q);
  const open = sequences.find((q) => q.id === rep) ?? null;
  const nCamp = sequences.filter(isCamp).length;
  return (
    <div className="cc">
      {sequences.length > 0 && (
        <section className="cc-figs" aria-label="The last 30 days">
          <div className="cc-fig is-pine">
            <span className="cc-fig-k"><i><Ico n="send" s={14} /></i>E-mails sent</span>
            <b className="cc-fig-v">{s30.sent}</b>
            <span className="cc-fig-s">{`to ${clients30} client${clients30 === 1 ? "" : "s"} · last 30 days`}</span>
          </div>
          <div className="cc-fig is-lime">
            <span className="cc-fig-k"><i><Ico n="eye" s={14} /></i>Opened</span>
            <b className="cc-fig-v">{pct(s30.opened, s30.sent)}<small>%</small></b>
            <span className="cc-fig-s">{`${s30.opened} of ${s30.sent}${s30.auto ? ` · ${s30.auto} mail-filter opens left out` : ""}`}</span>
          </div>
          <div className="cc-fig">
            <span className="cc-fig-k"><i><Ico n="click" s={14} /></i>Clicked</span>
            <b className="cc-fig-v">{pct(s30.clicked, s30.sent)}<small>%</small></b>
            <span className="cc-fig-s">{`${s30.clicked} people clicked a link`}</span>
          </div>
          <div className="cc-fig">
            <span className="cc-fig-k"><i><Ico n="reply" s={14} /></i>Replied</span>
            <b className="cc-fig-v">{s30.replied}</b>
            <span className="cc-fig-s">{pct(s30.replied, s30.sent)}% of e-mails sent{s30.failed ? <> · <em className="is-bad">{s30.failed} failed</em></> : ""}</span>
          </div>
        </section>
      )}
      {sequences.length > 0 && (
        <div className="cc-bar">
          <div className="cc-pills" role="tablist" aria-label="Show">
            {([["all", "Everything", sequences.length], ["campaign", "Campaigns", nCamp], ["sequence", "Sequences", sequences.length - nCamp]] as const).map(([k, l, n]) => (
              <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? "is-on" : ""} onClick={() => setKind(k)}>{l}<em>{n}</em></button>
            ))}
          </div>
        </div>
      )}
      {!sequences.length ? empty : (
        <div className="cc-grid">
          {shown.map((q, i) => {
            const mine = log.filter((l) => l.sequence_id === q.id);
            const st = statsOf(mine, true);
            const going = runs.filter((r) => r.sequence_id === q.id && r.status === "active");
            const camp = isCamp(q);
            const launched = camp ? !!q.launched_at : mine.length > 0;
            const r = reach(q);
            const next = going.filter((x) => x.next_at).sort((a, b) => a.next_at!.localeCompare(b.next_at!))[0];
            const status = camp
              ? (q.launched_at ? (going.length ? { t: "Sending", c: "is-going" } : { t: `Sent ${dShort(q.launched_at)}`, c: "is-sent" }) : { t: "Draft", c: "is-draft" })
              : (q.active ? { t: "On", c: "is-on" } : { t: "Off", c: "is-off" });
            const from = q.from_address || (q.sender === "owner" ? "each client's owner" : peopleName(q.created_by));
            return (
              <article key={q.id} className={`cc-card ${launched ? "is-live" : ""}`} style={{ ["--i" as any]: i }}
                onClick={(e) => { if (launched && !(e.target as Element).closest("button")) setRep(q.id); }}>
                <header className="cc-card-h">
                  <span className={`cc-ico ${camp ? "is-camp" : ""}`}><Ico n={camp ? "send" : "repeat"} s={17} /></span>
                  <div className="cc-card-t">
                    <b title={q.name}>{q.name || "Untitled"}</b>
                    <i>{`${camp ? "One-time campaign" : "Sequence"} · ${audience(q)}`}</i>
                  </div>
                  {camp ? <span className={`cc-st ${status.c}`}>{status.c === "is-going" && <span className="cc-pulse" />}{status.t}</span>
                    : <button type="button" role="switch" aria-checked={q.active} className={`cc-sw ${q.active ? "is-on" : ""}`} onClick={() => onToggle(q)}><i />{q.active ? "On" : "Off"}</button>}
                </header>
                {launched ? (
                  <div className="cc-funnel" aria-label="How it's going">
                    {([["Sent", st.sent, 100, "send"], ["Opened", st.opened, pct(st.opened, st.sent), "eye"], ["Clicked", st.clicked, pct(st.clicked, st.sent), "click"], ["Replied", st.replied, pct(st.replied, st.sent), "reply"]] as const).map(([l, n, p, ic], k) => (
                      <div key={l} className={`cc-fu is-${k}`}>
                        <span className="cc-fu-k"><Ico n={ic} s={12} />{l}</span>
                        <b>{k === 0 ? n : `${p}%`}</b>
                        <span className="cc-fu-bar"><i style={{ width: `${k === 0 ? (st.sent ? 100 : 0) : p}%` }} /></span>
                        <small>{k === 0 ? (st.failed ? `${st.failed} failed` : going.length ? `${going.length} to go` : "delivered") : `${n} of ${st.sent}`}</small>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="cc-plan">
                    <span><b>{r.clients}</b><i>client{r.clients === 1 ? "" : "s"}</i></span>
                    <span><b>{r.people}</b><i>{r.people === 1 ? "person" : "people"}</i></span>
                    <span className="is-wide"><b title={tplName(q.steps[0]?.template_id)}>{tplName(q.steps[0]?.template_id)}</b><i>{q.steps.length > 1 ? `+ ${q.steps.length - 1} more e-mail${q.steps.length === 2 ? "" : "s"}` : "the e-mail"}</i></span>
                  </div>
                )}
                <div className="cc-notes">
                  <p className="cc-note" title={`From ${from}`}><Ico n="mail" s={12} /><span>From {from} · to {q.recipients === "all" ? "every contact" : q.recipients === "billing" ? "the billing contact" : "the main contact"}</span></p>
                  {!camp && launched && (
                    <p className="cc-note"><Ico n="clock" s={12} /><span>{q.active ? (next?.next_at ? `Next e-mail ${dShort(next.next_at)} · ${going.length} client${going.length === 1 ? "" : "s"} in it` : `${going.length} client${going.length === 1 ? "" : "s"} in it`) : "Switched off — no more e-mails go out"}</span></p>
                  )}
                </div>
                <footer className="cc-card-f">
                  <span className="cc-sp" />
                  <button type="button" className="cc-rb" title={camp && q.launched_at ? "Copy, to send it again" : "Copy"} aria-label="Copy" onClick={() => onCopy(q)}><Ico n="repeat" s={14} /></button>
                  <button type="button" className="cc-rb" title="Delete" aria-label="Delete" onClick={() => onDelete(q)}><Ico n="trash" s={14} /></button>
                  <button type="button" className="cc-pill" onClick={() => onEdit(q)}><Ico n={camp && q.launched_at ? "eye" : "edit"} s={13} />{camp && q.launched_at ? "Settings" : "Edit"}</button>
                  {launched ? <button type="button" className="cc-pill is-lime" onClick={() => setRep(q.id)}><Ico n="chart" s={13} />Report</button>
                    : camp ? <button type="button" className="cc-pill is-dark" disabled={sending === q.id} onClick={() => onSend(q)}><Ico n="send" s={13} />{sending === q.id ? "Sending…" : "Send now"}</button> : null}
                </footer>
              </article>
            );
          })}
        </div>
      )}
      {open && <CsCampaignReport q={open} log={log} runs={runs} templates={templates} clients={clients} peopleName={peopleName} audience={audience(open)}
        onClose={() => setRep(null)} onEdit={() => { setRep(null); onEdit(open); }} onCopy={() => onCopy(open)} onOpenClient={(id) => { setRep(null); onOpenClient(id); }} />}
    </div>
  );
}

/* =====================================================================
   The report of one campaign / sequence
   ===================================================================== */
type RFilter = "all" | "opened" | "not" | "clicked" | "replied" | "failed";
export function CsCampaignReport({ q, log, runs, templates, clients, peopleName, audience, onClose, onEdit, onCopy, onOpenClient }: {
  q: CsSequence; log: CsMailLog[]; runs: CsRun[]; templates: CsTemplate[]; clients: CcClient[];
  peopleName: (id: string | null | undefined) => string; audience: string;
  onClose: () => void; onEdit: () => void; onCopy: () => void; onOpenClient: (id: string) => void;
}) {
  const [rows, setRows] = useState<CsMailLog[] | null>(null);
  const [at, setAt] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [noAuto, setNoAuto] = useState(true);
  const [f, setF] = useState<RFilter>("all");
  const [qq, setQq] = useState("");
  const [shut, setShut] = useState(false);
  const scRef = useRef<HTMLDivElement | null>(null);
  const [fade, setFade] = useState({ top: false, bot: false });
  const load = async () => {
    setBusy(true);
    const { data, error } = await supabase.from("cs_email_log").select("*").eq("sequence_id", q.id).order("sent_at", { ascending: false }).limit(5000);
    setRows(error || !Array.isArray(data) ? log.filter((l) => l.sequence_id === q.id) : (data as CsMailLog[]));
    setAt(Date.now()); setBusy(false);
  };
  useEffect(() => { void load(); const h = window.setInterval(() => void load(), 60_000); return () => window.clearInterval(h); }, [q.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => { setShut(true); window.setTimeout(onClose, 200); };
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", k);
    const html = document.documentElement; const prev = html.style.overflow; html.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", k); html.style.overflow = prev; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const onScroll = () => { const el = scRef.current; if (!el) return; setFade({ top: el.scrollTop > 4, bot: el.scrollTop + el.clientHeight < el.scrollHeight - 4 }); };
  useEffect(() => { onScroll(); }, [rows, f, qq]); // eslint-disable-line react-hooks/exhaustive-deps

  const all = rows ?? [];
  const st = statsOf(all, noAuto);
  const going = runs.filter((r) => r.sequence_id === q.id && r.status === "active").length;
  const camp = q.kind === "campaign";
  const first = all.length ? all.reduce((m, l) => (ms(l.sent_at) < ms(m.sent_at) ? l : m), all[0]) : null;
  const tplName = (id: string | null | undefined) => templates.find((t) => t.id === id)?.name ?? "Deleted blueprint";
  const client = (id: string | null | undefined) => clients.find((c) => c.id === id) ?? null;
  const person = (l: CsMailLog) => {
    const em = (l.to_emails ?? [])[0] ?? "";
    const c = client(l.client_id);
    const nm = c?.contacts.find((x) => (x.email ?? "").toLowerCase() === em.toLowerCase())?.name ?? "";
    return { name: nm, email: (l.to_emails ?? []).join(", ") };
  };
  const from = q.from_address || (q.sender === "owner" ? "each client's owner" : peopleName(q.launched_by ?? q.created_by));

  /* ---- over time: first opens and clicks, by hour (by day once it's longer than two days) ---- */
  const time = useMemo(() => {
    const sent = all.filter((l) => l.status === "sent");
    if (!sent.length) return null;
    const t0 = Math.min(...sent.map((l) => ms(l.sent_at)));
    const evs = sent.flatMap((l) => [ms(l.opened_at), ms(l.clicked_at), ms(l.replied_at)]).filter(Number.isFinite);
    const t1 = Math.max(Date.now(), ...evs);
    const span = t1 - t0;
    const step = span <= 8 * 36e5 ? 6e5 * (span <= 3 * 36e5 ? 1 : 3) : span <= 2 * 864e5 ? 36e5 : span <= 45 * 864e5 ? 864e5 : 7 * 864e5;
    const start = step <= 36e5 ? Math.floor(t0 / step) * step : (() => { const d = new Date(t0); d.setHours(0, 0, 0, 0); return d.getTime(); })();
    const n = Math.max(1, Math.min(60, Math.ceil((t1 - start) / step)));
    const b = Array.from({ length: n }, (_, k) => ({ at: start + k * step, opens: 0, clicks: 0, replies: 0 }));
    const put = (t: number, key: "opens" | "clicks" | "replies") => { if (!Number.isFinite(t)) return; const k = Math.min(n - 1, Math.max(0, Math.floor((t - start) / step))); b[k][key]++; };
    for (const l of sent) {
      const bot = noAuto && ccAuto(l);
      if (!bot) { put(ms(l.opened_at), "opens"); put(ms(l.clicked_at), "clicks"); }
      put(ms(l.replied_at), "replies");
    }
    const max = Math.max(1, ...b.map((x) => x.opens + x.replies), ...b.map((x) => x.clicks));
    const lab = (t: number) => (step <= 36e5 ? new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" }));
    const peak = b.reduce((m, x) => (x.opens > m.opens ? x : m), b[0]);
    return { b, max, lab, step, peak };
  }, [rows, noAuto]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- per client ---- */
  const byClient = useMemo(() => {
    const m = new Map<string, CsMailLog[]>();
    for (const l of all) { const k = l.client_id ?? "—"; m.set(k, [...(m.get(k) ?? []), l]); }
    const rank: Record<Stage, number> = { replied: 5, clicked: 4, opened: 3, sent: 2, skipped: 1, failed: 0 };
    return [...m.entries()].map(([id, ls]) => {
      const s = statsOf(ls, noAuto);
      const best = ls.map((l) => stageOf(l, noAuto)).sort((a, b) => rank[b] - rank[a])[0] ?? "sent";
      const last = ls.flatMap((l) => [l.replied_at, l.clicked_at, l.opened_at]).filter(Boolean).sort().pop() ?? null;
      return { id, name: client(id)?.name ?? "Client", s, best, n: ls.length, last };
    }).sort((a, b) => rank[b.best] - rank[a.best] || b.s.opened - a.s.opened || a.name.localeCompare(b.name));
  }, [rows, noAuto, clients]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- versions and e-mails (steps) ---- */
  const groups = (key: (l: CsMailLog) => string) => {
    const m = new Map<string, CsMailLog[]>();
    for (const l of all) m.set(key(l), [...(m.get(key(l)) ?? []), l]);
    return [...m.entries()].map(([k, ls]) => ({ k, s: statsOf(ls, noAuto) })).sort((a, b) => b.s.sent - a.s.sent);
  };
  const versions = groups((l) => l.variant || "Main version");
  const emails = groups((l) => l.template_id ?? "—");

  /* ---- every recipient ---- */
  const filt = (l: CsMailLog) => {
    const s = stageOf(l, noAuto);
    if (f === "opened" && !(s === "opened" || s === "clicked" || s === "replied")) return false;
    if (f === "not" && s !== "sent") return false;
    if (f === "clicked" && !(s === "clicked" || (s === "replied" && l.clicked_at))) return false;
    if (f === "replied" && s !== "replied") return false;
    if (f === "failed" && !(s === "failed" || s === "skipped")) return false;
    if (qq.trim()) {
      const p = person(l); const hay = `${p.name} ${p.email} ${client(l.client_id)?.name ?? ""}`.toLowerCase();
      if (!hay.includes(qq.trim().toLowerCase())) return false;
    }
    return true;
  };
  const list = all.filter(filt).sort((a, b) => {
    const r: Record<Stage, number> = { replied: 0, clicked: 1, opened: 2, sent: 3, skipped: 4, failed: 5 };
    return r[stageOf(a, noAuto)] - r[stageOf(b, noAuto)] || (ms(a.opened_at) || Infinity) - (ms(b.opened_at) || Infinity);
  });
  const cnt = (k: RFilter) => all.filter((l) => {
    const s = stageOf(l, noAuto);
    return k === "all" ? true : k === "opened" ? s === "opened" || s === "clicked" || s === "replied" : k === "not" ? s === "sent"
      : k === "clicked" ? s === "clicked" || (s === "replied" && !!l.clicked_at) : k === "replied" ? s === "replied" : s === "failed" || s === "skipped";
  }).length;

  const exportXlsx = () => {
    const cols: [string, "text" | "number" | "date"][] = [["Client", "text"], ["Name", "text"], ["E-mail", "text"], ["Version", "text"], ["E-mail sent", "text"], ["Status", "text"],
      ["Sent", "date"], ["Opened", "date"], ["Opens", "number"], ["Clicked", "date"], ["Clicks", "number"], ["Replied", "date"], ["Mail filter?", "text"], ["Error", "text"]];
    const out: ExportCell[][] = all.map((l) => {
      const p = person(l);
      return [client(l.client_id)?.name ?? "", p.name, p.email, l.variant || "Main version", tplName(l.template_id), STAGE_LABEL[stageOf(l, false)],
        l.sent_at ? { date: l.sent_at } : null, l.opened_at ? { date: l.opened_at } : null, Number(l.opens) || (l.opened_at ? 1 : 0),
        l.clicked_at ? { date: l.clicked_at } : null, Number(l.clicks) || (l.clicked_at ? 1 : 0), l.replied_at ? { date: l.replied_at } : null, ccAuto(l) ? "Probably" : "", l.error ?? ""];
    });
    downloadBlob(tableToXlsx({ columns: cols.map(([label, format]) => ({ label, format })), rows: out }, "Report"), `${(q.name || "campaign").replace(/[\\/:*?"<>|]+/g, "-")} — report.xlsx`);
  };

  const tiles = [
    { k: "Sent", v: String(st.sent), s: st.failed ? `${st.failed} failed${going ? ` · ${going} to go` : ""}` : going ? `${going} client${going === 1 ? "" : "s"} still to go` : `to ${byClient.filter((c) => c.s.sent).length} client${byClient.filter((c) => c.s.sent).length === 1 ? "" : "s"}`, c: "is-pine", ic: "send" as const },
    { k: "Opened", v: `${pct(st.opened, st.sent)}%`, s: `${st.opened} of ${st.sent} people`, c: "is-lime", ic: "eye" as const },
    { k: "Clicked", v: `${pct(st.clicked, st.sent)}%`, s: st.opened ? `${pct(st.clicked, st.opened)}% of those who opened` : `${st.clicked} people`, c: "", ic: "click" as const },
    { k: "Replied", v: `${pct(st.replied, st.sent)}%`, s: `${st.replied} repl${st.replied === 1 ? "y" : "ies"} seen in a mailbox`, c: "", ic: "reply" as const },
  ];
  const fun = [
    { l: "Sent", n: st.sent }, { l: "Opened", n: st.opened }, { l: "Clicked", n: st.clicked }, { l: "Replied", n: st.replied },
  ];

  return createPortal(
    <div className={`cc-rep-bg ${shut ? "is-shut" : ""}`} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="cc-rep" role="dialog" aria-modal="true" aria-label={`${q.name}: report`}>
        <header className="cc-rep-h">
          <span className={`cc-ico is-big ${camp ? "is-camp" : ""}`}><Ico n={camp ? "send" : "repeat"} s={20} /></span>
          <div className="cc-rep-t">
            <span className="cc-eyebrow">{camp ? "One-time campaign" : "Sequence"}{first ? ` · first sent ${dFull(q.launched_at ?? first.sent_at)}` : ""}</span>
            <h2>{q.name || "Untitled"}</h2>
            <span className="cc-rep-meta">
              <span><Ico n="users" s={12} />{audience}</span>
              <span><Ico n="mail" s={12} />From {from}</span>
              {camp && q.launched_by && <span><Ico n="play" s={11} />Sent by {peopleName(q.launched_by)}</span>}
            </span>
          </div>
          <div className="cc-rep-acts">
            <span className="cc-upd" title="It updates by itself every minute">{busy ? "Updating…" : at ? `Updated ${new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : ""}</span>
            <button type="button" className="cc-rb is-w" aria-label="Update now" title="Update now" onClick={() => void load()}><Ico n="refresh" s={15} /></button>
            <button type="button" className="cc-pill is-w" onClick={exportXlsx} disabled={!all.length}><Ico n="down" s={13} />Export</button>
            <button type="button" className="cc-pill is-w" onClick={onCopy} title={camp ? "A new draft with the same settings" : "Copy"}><Ico n="repeat" s={13} />{camp ? "Send again" : "Copy"}</button>
            <button type="button" className="cc-pill is-w" onClick={onEdit}><Ico n="edit" s={13} />Settings</button>
            <button type="button" className="cc-rb is-w" aria-label="Close" onClick={close}><Ico n="x" s={16} /></button>
          </div>
        </header>

        <div className={`cc-rep-sc ${fade.top ? "is-ft" : ""} ${fade.bot ? "is-fb" : ""}`} ref={scRef} onScroll={onScroll}>
          {rows == null ? <div className="cc-load"><span /><span /><span /><span /></div> : !all.length ? (
            <div className="cc-empty"><span className="cc-ico is-big"><Ico n="clock" s={20} /></span><b>Nothing sent yet</b><i>{going ? `${going} client${going === 1 ? "" : "s"} get it on the next hourly run.` : "Once it goes out, every e-mail shows here: who opened it, clicked and replied."}</i></div>
          ) : (<>
            <section className="cc-figs is-rep">
              {tiles.map((x) => (
                <div key={x.k} className={`cc-fig ${x.c}`}>
                  <span className="cc-fig-k"><i><Ico n={x.ic} s={14} /></i>{x.k}</span>
                  <b className="cc-fig-v">{x.v.replace("%", "")}{x.v.endsWith("%") && <small>%</small>}</b>
                  <span className="cc-fig-s">{x.s}</span>
                </div>
              ))}
            </section>

            {st.auto > 0 && (
              <div className={`cc-filter-note ${noAuto ? "is-on" : ""}`}>
                <span className="cc-ico is-sm"><Ico n="shield" s={14} /></span>
                <p><b>{st.auto} open{st.auto === 1 ? "" : "s"} came within a minute of sending.</b> That's usually a company's mail filter checking the e-mail (and its links), not a person reading it. {noAuto ? "They're left out of the figures." : "They're counted as opens."}</p>
                <button type="button" role="switch" aria-checked={noAuto} className={`cc-sw ${noAuto ? "is-on" : ""}`} onClick={() => setNoAuto(!noAuto)}><i />Leave them out</button>
              </div>
            )}

            <div className="cc-two">
              <section className="cc-panel">
                <header className="cc-panel-h"><span className="cc-ico is-sm"><Ico n="layers" s={14} /></span><b>From sent to replied</b></header>
                <div className="cc-fn">
                  {fun.map((x, k) => (
                    <div key={x.l} className={`cc-fn-r is-${k}`}>
                      <span className="cc-fn-l">{x.l}</span>
                      <span className="cc-fn-bar"><i style={{ width: `${Math.max(x.n ? 3 : 0, pct(x.n, st.sent || 1))}%` }}><em>{x.n}</em></i></span>
                      <span className="cc-fn-p">{k === 0 ? "100%" : `${pct(x.n, st.sent)}%`}</span>
                    </div>
                  ))}
                </div>
                <p className="cc-fn-foot">
                  {st.sent ? `${st.sent - st.opened} haven't opened it yet` : ""}{st.failed ? ` · ${st.failed} couldn't go out` : ""}{st.skipped ? ` · ${st.skipped} skipped` : ""}
                </p>
              </section>
              <section className="cc-panel">
                <header className="cc-panel-h"><span className="cc-ico is-sm"><Ico n="chart" s={14} /></span><b>When they opened it</b>
                  <span className="cc-legend"><i className="is-o" />Opens<i className="is-c" />Clicks<i className="is-r" />Replies</span></header>
                {time ? (
                  <div className="cc-tl">
                    <div className="cc-tl-bars" style={{ ["--n" as any]: time.b.length }}>
                      {time.b.map((x, k) => (
                        <div key={k} className="cc-tl-c" title={`${time.lab(x.at)}${time.step <= 36e5 ? ` ${dShort(new Date(x.at).toISOString())}` : ""} — ${x.opens} open${x.opens === 1 ? "" : "s"} · ${x.clicks} click${x.clicks === 1 ? "" : "s"}${x.replies ? ` · ${x.replies} repl${x.replies === 1 ? "y" : "ies"}` : ""}`}>
                          <span className="cc-tl-st">
                            {x.replies > 0 && <i className="is-r" style={{ height: `${(x.replies / time.max) * 100}%` }} />}
                            <i className="is-o" style={{ height: `${(x.opens / time.max) * 100}%` }} />
                          </span>
                          <span className="cc-tl-cl"><i className="is-c" style={{ height: `${(x.clicks / time.max) * 100}%` }} /></span>
                        </div>
                      ))}
                    </div>
                    <div className="cc-tl-ax">
                      {time.b.map((x, k) => {
                        const every = Math.max(1, Math.ceil(time.b.length / 6));
                        return <span key={k}>{k % every === 0 ? time.lab(x.at) : ""}</span>;
                      })}
                    </div>
                    <p className="cc-fn-foot">{time.peak.opens ? `Most opens ${time.step <= 36e5 ? `around ${time.lab(time.peak.at)}` : `on ${time.lab(time.peak.at)}`} (${time.peak.opens})` : "No opens yet"}{time.step < 36e5 ? ` · every ${time.step / 6e4} minutes` : time.step === 36e5 ? " · by hour" : time.step === 864e5 ? " · by day" : " · by week"}</p>
                  </div>
                ) : <p className="cc-muted">Nothing yet.</p>}
              </section>
            </div>

            {(versions.length > 1 || emails.length > 1) && (
              <div className={`cc-two ${versions.length > 1 && emails.length > 1 ? "" : "is-one"}`}>
                {versions.length > 1 && (
                  <section className="cc-panel">
                    <header className="cc-panel-h"><span className="cc-ico is-sm"><Ico n="layers" s={14} /></span><b>By version</b></header>
                    <div className="cc-cmp">
                      {versions.map((v) => <CmpRow key={v.k} name={v.k} s={v.s} best={versions.every((o) => pct(o.s.opened, o.s.sent) <= pct(v.s.opened, v.s.sent))} />)}
                    </div>
                  </section>
                )}
                {emails.length > 1 && (
                  <section className="cc-panel">
                    <header className="cc-panel-h"><span className="cc-ico is-sm"><Ico n="mail" s={14} /></span><b>By e-mail</b></header>
                    <div className="cc-cmp">
                      {emails.map((v) => <CmpRow key={v.k} name={tplName(v.k)} s={v.s} best={false} />)}
                    </div>
                  </section>
                )}
              </div>
            )}

            <section className="cc-panel">
              <header className="cc-panel-h"><span className="cc-ico is-sm"><Ico n="building" s={14} /></span><b>By client</b><span className="cc-muted">{byClient.length} client{byClient.length === 1 ? "" : "s"} · {byClient.filter((c) => c.best === "replied" || c.best === "clicked" || c.best === "opened").length} opened it</span></header>
              <div className="cc-clients">
                {byClient.map((c, i) => (
                  <button key={c.id} type="button" className="cc-cl" style={{ ["--i" as any]: i }} onClick={() => c.id !== "—" && onOpenClient(c.id)} disabled={c.id === "—"}>
                    <span className="cc-av">{c.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase()}</span>
                    <span className="cc-cl-t"><b>{c.name}</b><i title={c.last ? `Last opened ${dFull(c.last)}` : undefined}>{c.s.opened} of {c.s.sent} opened{c.s.clicked ? ` · ${c.s.clicked} clicked` : ""}{c.s.failed ? ` · ${c.s.failed} failed` : ""}</i></span>
                    <span className="cc-dots" aria-hidden="true">{Array.from({ length: Math.min(c.n, 8) }, (_, k) => <i key={k} className={k < c.s.opened ? "is-on" : ""} />)}</span>
                    <span className={`cc-tag is-${c.best}`}>{STAGE_LABEL[c.best]}</span>
                  </button>
                ))}
              </div>
            </section>

            <section className="cc-panel">
              <header className="cc-panel-h"><span className="cc-ico is-sm"><Ico n="users" s={14} /></span><b>Every e-mail</b>
                <label className="cc-search"><Ico n="search" s={13} /><input value={qq} onChange={(e) => setQq(e.target.value)} placeholder="Search a person or client" aria-label="Search a person or client" /></label>
              </header>
              <div className="cc-chips" role="tablist" aria-label="Show">
                {([["all", "Everyone"], ["opened", "Opened"], ["not", "Not opened"], ["clicked", "Clicked"], ["replied", "Replied"], ["failed", "Failed"]] as const).map(([k, l]) => (
                  <button key={k} type="button" role="tab" aria-selected={f === k} className={f === k ? "is-on" : ""} onClick={() => setF(k)}>{l}<em>{cnt(k)}</em></button>
                ))}
              </div>
              <div className="cc-tbl">
                <div className="cc-tr is-h"><span>Person</span><span>Client</span><span>Sent</span><span>Opened</span><span>Clicked</span><span>Replied</span><span>Status</span></div>
                {list.map((l) => {
                  const p = person(l); const s = stageOf(l, noAuto); const bot = ccAuto(l);
                  return (
                    <div key={l.id} className={`cc-tr is-${s} ${bot && noAuto ? "is-bot" : ""}`}>
                      <span className="cc-td-p"><b>{p.name || p.email || "—"}</b>{p.name && <i>{p.email}</i>}</span>
                      <span className="cc-td-c">{l.client_id ? <button type="button" onClick={() => onOpenClient(l.client_id!)}>{client(l.client_id)?.name ?? "—"}</button> : "—"}{l.variant && <em>{l.variant}</em>}</span>
                      <span className="cc-td-d"><b>{dShort(l.sent_at)}</b><i>{dTime(l.sent_at)}</i></span>
                      <span className="cc-td-d">{l.opened_at ? <><b>{after(l.sent_at, l.opened_at)} later</b><i>{dShort(l.opened_at)} {dTime(l.opened_at)}{Number(l.opens) > 1 ? ` · ${l.opens}×` : ""}</i>{bot && <em className="cc-bot" title="Within a minute of sending — probably a mail filter">filter?</em>}</> : <i>—</i>}</span>
                      <span className="cc-td-d">{l.clicked_at ? <><b>{dShort(l.clicked_at)}</b><i>{dTime(l.clicked_at)}{Number(l.clicks) > 1 ? ` · ${l.clicks}×` : ""}</i></> : <i>—</i>}</span>
                      <span className="cc-td-d">{l.replied_at ? <><b>{dShort(l.replied_at)}</b><i>{dTime(l.replied_at)}</i></> : <i>—</i>}</span>
                      <span className="cc-td-s"><em className={`cc-tag is-${s}`}>{STAGE_LABEL[s]}</em>{l.error && <i title={l.error}>{l.error}</i>}</span>
                    </div>
                  );
                })}
                {!list.length && <p className="cc-muted is-pad">No one here.</p>}
              </div>
            </section>
          </>)}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function CmpRow({ name, s, best }: { name: string; s: Stats; best: boolean }) {
  return (
    <div className={`cc-cmp-r ${best ? "is-best" : ""}`}>
      <span className="cc-cmp-n"><b title={name}>{name}</b><i>{s.sent} sent</i></span>
      {([["Opened", s.opened], ["Clicked", s.clicked], ["Replied", s.replied]] as const).map(([l, n]) => (
        <span key={l} className="cc-cmp-m"><b>{pct(n, s.sent)}%</b><span className="cc-fu-bar"><i style={{ width: `${pct(n, s.sent)}%` }} /></span><i>{l.toLowerCase()}</i></span>
      ))}
      {best && <em className="cc-best">Best</em>}
    </div>
  );
}
