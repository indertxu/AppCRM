import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { supabase } from "../../api/supabase";
import Select from "../../framework/Select";
import { listEmployees } from "../companies/companiesApi";
import "./HandoffAlertsSettings.css";

/* =====================================================================
   Management › Settings › Notifications (128_handoff_alerts.sql).
   Who is told when sales hands over a won deal: for every handoff, and/or
   only for those going to one destination (a service pipeline). Kept in
   billing_settings.handoff_notify; the database sends the notifications.
   ===================================================================== */

interface Cfg { all: string[]; pipelines: Record<string, string[]> }
interface Person { id: string; name: string; email?: string; former?: boolean }
interface Dest { id: string; name: string; from: string[] }

const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
const hue = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const clean = (c: any): Cfg => ({
  all: Array.isArray(c?.all) ? c.all.filter((x: any) => typeof x === "string") : [],
  pipelines: c?.pipelines && typeof c.pipelines === "object" ? Object.fromEntries(Object.entries(c.pipelines).map(([k, v]) => [k, Array.isArray(v) ? (v as any[]).filter((x) => typeof x === "string") : []])) : {},
});

export default function HandoffAlertsSettings({ canEdit = true }: { canEdit?: boolean }) {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [dests, setDests] = useState<Dest[]>([]);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error" | "missing">("idle");
  const [err, setErr] = useState("");
  const savedSig = useRef("");

  useEffect(() => {
    let off = false;
    (async () => {
      const [bs, es, pipes, phases] = await Promise.all([
        supabase.from("billing_settings").select("id, handoff_notify").eq("id", "default").maybeSingle(),
        listEmployees().catch(() => []),
        supabase.from("pipelines").select("id, name, is_sales"),
        supabase.from("pipeline_phases").select("pipeline_id, handover_to").not("handover_to", "is", null),
      ]);
      if (off) return;
      if (bs.error && /handoff_notify/i.test(bs.error.message)) setState("missing");
      const c = clean((bs.data as any)?.handoff_notify);
      savedSig.current = JSON.stringify(c);
      setCfg(c);
      setPeople((es as any[]).map((e) => ({ id: e.id, name: e.name, email: e.email, former: e.former })));
      // destinations: the pipelines sales hands over to (where they come from, for the hint)
      const ps = (pipes.data ?? []) as { id: string; name: string; is_sales: boolean }[];
      const byId = new Map(ps.map((p) => [p.id, p]));
      const to = new Map<string, Set<string>>();
      ((phases.data ?? []) as { pipeline_id: string; handover_to: string }[]).forEach((r) => {
        if (!to.has(r.handover_to)) to.set(r.handover_to, new Set());
        const src = byId.get(r.pipeline_id)?.name; if (src) to.get(r.handover_to)!.add(src);
      });
      const list: Dest[] = [...to.entries()].map(([id, from]) => ({ id, name: byId.get(id)?.name ?? "A pipeline", from: [...from].sort() }));
      // a destination someone already set but no longer handed over to stays visible, so it can be cleared
      Object.keys(c.pipelines).forEach((id) => { if (!to.has(id) && c.pipelines[id]?.length) list.push({ id, name: byId.get(id)?.name ?? "A removed pipeline", from: [] }); });
      setDests(list.sort((a, b) => a.name.localeCompare(b.name)));
    })().catch((e) => { if (!off) { setErr(String(e?.message ?? e)); setCfg({ all: [], pipelines: {} }); } });
    return () => { off = true; };
  }, []);

  // each change is kept a moment later
  useEffect(() => {
    if (!cfg || !canEdit) return;
    const sig = JSON.stringify(cfg);
    if (sig === savedSig.current) return;
    const t = window.setTimeout(async () => {
      setState("saving");
      const { error } = await supabase.from("billing_settings").upsert({ id: "default", handoff_notify: cfg });
      if (error) { setState(/handoff_notify/i.test(error.message) ? "missing" : "error"); setErr(error.message); return; }
      savedSig.current = sig; setState("saved");
      window.setTimeout(() => setState((s) => (s === "saved" ? "idle" : s)), 1600);
    }, 450);
    return () => window.clearTimeout(t);
  }, [cfg, canEdit]);

  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const nameOf = (id: string) => byId.get(id)?.name ?? "Someone who left";
  const total = cfg ? new Set([...cfg.all, ...Object.values(cfg.pipelines).flat()]).size : 0;

  const setList = (key: string | null, ids: string[]) => setCfg((c) => {
    if (!c) return c;
    if (key == null) return { ...c, all: ids };
    const pipelines = { ...c.pipelines, [key]: ids };
    if (!ids.length) delete pipelines[key];
    return { ...c, pipelines };
  });

  const group = (key: string | null, title: string, sub: string, ids: string[], tone: string) => {
    const options = people.filter((p) => !p.former && !ids.includes(p.id)).map((p) => ({ value: p.id, label: p.name, hint: p.email || undefined }));
    return (
      <section className={`hfa-card ${ids.length ? "is-on" : ""}`} style={{ "--t": tone } as CSSProperties} key={key ?? "all"}>
        <header className="hfa-card-h">
          <span className="hfa-card-ico" aria-hidden="true">
            {key == null
              ? <svg viewBox="0 0 24 24"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
              : <svg viewBox="0 0 24 24"><path d="M3 12h13M12 6l6 6-6 6M21 5v14" /></svg>}
          </span>
          <div className="hfa-card-t"><b title={title}>{title}</b><em title={sub}>{sub}</em></div>
          <span className="hfa-count">{ids.length ? `${ids.length} ${ids.length === 1 ? "person" : "people"}` : "Nobody"}</span>
        </header>
        <div className="hfa-people">
          {ids.map((id) => (
            <span className={`hfa-chip ${byId.get(id)?.former ? "is-former" : ""}`} key={id} title={byId.get(id)?.email ?? ""}>
              <i style={{ "--h": hue(nameOf(id)) } as CSSProperties}>{initials(nameOf(id))}</i>
              <span>{nameOf(id)}</span>
              {canEdit && (
                <button type="button" onClick={() => setList(key, ids.filter((x) => x !== id))} aria-label={`Stop telling ${nameOf(id)}`} title="Stop telling them">
                  <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              )}
            </span>
          ))}
          {canEdit && (
            <span className="hfa-add">
              <Select size="sm" value="" onChange={(v) => v && setList(key, [...ids, v])} options={options} searchable placeholder="+ Add someone" aria-label={`Add someone to ${title}`} />
            </span>
          )}
          {!canEdit && !ids.length && <span className="hfa-none">Nobody is told.</span>}
        </div>
      </section>
    );
  };

  if (!cfg) return <div className="hfa"><div className="hfa-skel"><i /><i /><i /></div></div>;
  return (
    <div className="hfa">
      <div className="hfa-top">
        <div className="hfa-top-t">
          <b>New handoffs</b>
          <em>When sales hands over a won deal, these people get a notification that opens Management › Incoming. The person who sends it isn't told.</em>
        </div>
        <span className={`hfa-state is-${state}`} aria-live="polite">
          {state === "saving" ? "Saving…" : state === "saved" ? "Saved" : state === "error" ? "Not saved" : total ? `${total} ${total === 1 ? "person is" : "people are"} told` : "Nobody is told yet"}
        </span>
      </div>
      {state === "missing" && <p className="hfa-warn">Run <b>128_handoff_alerts.sql</b> in Supabase to keep these.</p>}
      {state === "error" && err && <p className="hfa-warn">{err}</p>}
      {group(null, "Every handoff", "Whatever it is and wherever it goes", cfg.all, "#12b57f")}
      {dests.length > 0 && (
        <>
          <div className="hfa-sec"><span>Only handoffs going to</span><em>On top of the people above</em></div>
          <div className="hfa-grid">
            {dests.map((d) => group(d.id, d.name, d.from.length ? `From ${d.from.join(", ")}` : "No pipeline hands over here any more", cfg.pipelines[d.id] ?? [], `hsl(${hue(d.name)} 52% 42%)`))}
          </div>
        </>
      )}
    </div>
  );
}
