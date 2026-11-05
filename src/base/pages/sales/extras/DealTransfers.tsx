import { useMemo, useState, type CSSProperties } from "react";
import SalesMultiFilter from "../sales/SalesMultiFilter";
import type { Phase, Pipeline } from "../../settings/pipelineApi";
import type { Tracking } from "../sales/salesApi";
import type { SalesRole } from "./salesRolesApi";
import { dealCounts, planTransfer, runTransfer, type TransferOptions } from "./dealTransferApi";

const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
const eur = (n: number) => `${Math.round(n).toLocaleString("es-ES")} €`;

/** Actions → Sales roles → Transfers: every deal from one person to another. */
export default function DealTransfers({ canEdit, people, inactive, trackings, owners, teams, totals, roles, pipelines, phaseByPipe, dealTitle, meId, onDone }: {
  canEdit: boolean;
  /** Everyone, former employees included (they're who you transfer from). */
  people: { id: string; name: string }[];
  inactive: Set<string>;
  trackings: Tracking[];
  owners: Record<string, string>;
  teams: Record<string, string[]>;
  totals: Record<string, number>;
  roles: SalesRole[];
  pipelines: Pipeline[];
  phaseByPipe: Record<string, Phase[]>;
  dealTitle: (t: Tracking) => string;
  meId: string | null;
  onDone: () => void;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [scope, setScope] = useState<TransferOptions["scope"]>("all");
  const [which, setWhich] = useState<TransferOptions["which"]>("open");
  const [keepFrom, setKeepFrom] = useState(false);
  const [note, setNote] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ moved: number; failed: number; from: string; to: string } | null>(null);

  const name = (id: string) => people.find((p) => p.id === id)?.name ?? "—";
  const counts = useMemo(() => dealCounts(trackings, owners, teams), [trackings, owners, teams]);
  const items = useMemo(() => planTransfer(trackings, owners, teams, { from, to, scope, which }), [trackings, owners, teams, from, to, scope, which]);
  const value = items.reduce((s, it) => s + (totals[it.t.id] ?? 0), 0);
  const owned = items.filter((i) => i.wasOwner).length;
  const pipeName = (id: string | null) => pipelines.find((p) => p.id === id)?.name ?? "—";
  const phaseName = (t: Tracking) => (phaseByPipe[t.pipeline_id ?? ""] ?? []).find((p) => p.id === t.current_phase_id)?.name ?? "—";

  const fromOptions = people
    .filter((p) => (counts[p.id]?.all ?? 0) > 0)
    .sort((a, b) => (counts[b.id]?.open ?? 0) - (counts[a.id]?.open ?? 0) || a.name.localeCompare(b.name))
    .map((p) => ({ value: p.id, label: `${p.name}${inactive.has(p.id) ? " (former)" : ""} · ${counts[p.id]?.open ?? 0} open` }));
  const toOptions = people.filter((p) => !inactive.has(p.id) && p.id !== from).map((p) => ({ value: p.id, label: p.id === meId ? `${p.name} (you)` : p.name }));

  const go = async () => {
    setConfirming(false);
    setBusy({ done: 0, total: items.length });
    const r = await runTransfer(items, { from, to, scope, which, keepFrom, note }, { roles, names: { from: name(from), to: name(to), by: meId ? name(meId) : "someone" } },
      (done) => setBusy({ done, total: items.length }));
    setBusy(null);
    setResult({ moved: r.moved, failed: r.failed.length, from: name(from), to: name(to) });
    setFrom("");
    onDone();
  };

  if (busy) {
    return (
      <div className="dtr-run">
        <span className="dtr-run-bar" style={{ ["--p" as string]: busy.total ? busy.done / busy.total : 0 } as CSSProperties}><i /></span>
        <b>Moving deals… {busy.done} of {busy.total}</b>
        <small>Keep this open.</small>
      </div>
    );
  }

  return (
    <div className="dtr">
      <p className="srl-intro">Move <b>someone's deals to a colleague</b> in one go — when they leave, change team or go on leave. On each deal the new person takes their place: <b>owner</b> where they were the owner, on the team otherwise.</p>
      {!canEdit && <p className="srl-note is-soft">Only bosses, sales managers and marketing managers can transfer deals.</p>}
      {result && (
        <div className={`dtr-done ${result.failed ? "is-partial" : ""}`}>
          <span className="dtr-done-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></span>
          <span><b>{result.moved} {result.moved === 1 ? "deal" : "deals"} moved</b> from {result.from} to {result.to}.{result.failed ? ` ${result.failed} couldn't be changed — check you can edit them.` : ""}</span>
          <button onClick={() => setResult(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      <div className="dtr-pick">
        <div className="dtr-side">
          <label>From</label>
          <SalesMultiFilter single values={[from || "__none"]} onChange={(v) => { if (v[0] && v[0] !== "__none") { setFrom(v[0]); if (v[0] === to) setTo(""); setConfirming(false); } }}
            options={[{ value: "__none", label: "Choose a person" }, ...fromOptions]} placeholder="Choose a person" searchFrom={8} />
          {from && <small>{counts[from]?.open ?? 0} open · {counts[from]?.all ?? 0} in total · owns {counts[from]?.owned ?? 0}</small>}
        </div>
        <span className="dtr-arrow" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6" /></svg></span>
        <div className="dtr-side">
          <label>To</label>
          <SalesMultiFilter single values={[to || "__none"]} onChange={(v) => { if (v[0] && v[0] !== "__none") { setTo(v[0]); setConfirming(false); } }}
            options={[{ value: "__none", label: "Choose a person" }, ...toOptions]} placeholder="Choose a person" searchFrom={8} />
          {to && <small>{counts[to]?.open ?? 0} open deals today</small>}
        </div>
      </div>

      <div className="dtr-opts">
        <div className="dtr-opt">
          <span>Which deals</span>
          <div className="srl-seg">
            <button className={which === "open" ? "is-on" : ""} onClick={() => setWhich("open")}>Open</button>
            <button className={which === "all" ? "is-on" : ""} onClick={() => setWhich("all")}>All, won & lost too</button>
          </div>
        </div>
        <div className="dtr-opt">
          <span>Where they are</span>
          <div className="srl-seg">
            <button className={scope === "all" ? "is-on" : ""} onClick={() => setScope("all")}>Every deal they're on</button>
            <button className={scope === "owned" ? "is-on" : ""} onClick={() => setScope("owned")}>Only as owner</button>
          </div>
        </div>
        <label className="dtr-check"><input type="checkbox" checked={keepFrom} onChange={(e) => setKeepFrom(e.target.checked)} /><span />Keep {from ? name(from).split(" ")[0] : "them"} on the deals too</label>
        <label className="dtr-check"><input type="checkbox" checked={note} onChange={(e) => setNote(e.target.checked)} /><span />Leave a note on each deal</label>
      </div>

      {from && to && (
        <section className="dtr-preview">
          <header>
            <span className="dtr-avs"><i>{initials(name(from))}</i><svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6" /></svg><i className="is-to">{initials(name(to))}</i></span>
            <span className="dtr-sum"><b>{items.length} {items.length === 1 ? "deal" : "deals"}</b>{items.length > 0 && <> · {eur(value)} · owner of {owned}</>}</span>
          </header>
          {items.length === 0 ? <p className="dtr-empty">No {which === "open" ? "open " : ""}deals to move with these options.</p> : (
            <ul className="dtr-list">
              {items.slice(0, 60).map((it, i) => (
                <li key={it.t.id} style={{ ["--i" as string]: Math.min(i, 16) } as CSSProperties}>
                  <b>{dealTitle(it.t)}</b>
                  <small>{pipeName(it.t.pipeline_id)} · {phaseName(it.t)}{it.t.status === "won" ? " · won" : it.t.status === "lost" ? " · lost" : ""}</small>
                  <span className={`dtr-tag ${it.wasOwner ? "is-owner" : ""}`}>{it.wasOwner ? "Owner" : "Team"}</span>
                  <span className="dtr-val">{totals[it.t.id] ? eur(totals[it.t.id]) : "—"}</span>
                </li>
              ))}
              {items.length > 60 && <li className="dtr-more">+{items.length - 60} more</li>}
            </ul>
          )}
        </section>
      )}

      {from && to && items.length > 0 && canEdit && (
        confirming ? (
          <div className="dtr-confirm">
            <p>Move <b>{items.length} {items.length === 1 ? "deal" : "deals"}</b> from <b>{name(from)}</b> to <b>{name(to)}</b>?{!keepFrom && ` ${name(from).split(" ")[0]} will no longer be on them.`} This can't be undone in one click.</p>
            <div>
              <button className="dw-cancel" onClick={() => setConfirming(false)}>Cancel</button>
              <button className="dw-save dtr-go" onClick={go}>Yes, transfer</button>
            </div>
          </div>
        ) : (
          <button className="dw-save dtr-start" onClick={() => setConfirming(true)}>Transfer {items.length} {items.length === 1 ? "deal" : "deals"}</button>
        )
      )}
    </div>
  );
}