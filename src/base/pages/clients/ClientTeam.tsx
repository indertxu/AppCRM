/* =====================================================================
   BASE · Client workspace — who works on this client (clients.team).
   Only the people on the team can log work or shipments for the client in
   the calendar; with nobody on it, everyone can. Management sees all.
   ===================================================================== */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { supabase } from "../../../components/api/supabase";
import Select from "../../framework/Select";
import { loadPeople, type Person } from "../billing/billingApi";
import "./ClientTeam.css";

interface Member { userId: string; name?: string }
interface Props {
  clientId: string;
  canEdit: boolean;
  /** The workspace's section header (icon, title, the sub line and the tools at the right). */
  head: (sub: ReactNode, tools: ReactNode) => ReactNode;
}

const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
const HUE = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

export default function ClientTeam({ clientId, canEdit, head }: Props) {
  const [team, setTeam] = useState<Member[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    supabase.from("clients").select("team").eq("id", clientId).maybeSingle().then(({ data }) => {
      if (alive) setTeam(Array.isArray((data as any)?.team) ? ((data as any).team as Member[]).filter((m) => m?.userId) : []);
    });
    loadPeople().then((p) => alive && setPeople(p.filter((x) => x.active))).catch(() => {});
    return () => { alive = false; };
  }, [clientId]);

  const nameOf = (m: Member) => people.find((p) => p.id === m.userId)?.name ?? m.name ?? "Someone";
  const options = useMemo(() => people.filter((p) => !(team ?? []).some((m) => m.userId === p.id)).map((p) => ({ value: p.id, label: p.name })), [people, team]);

  const save = async (next: Member[]) => {
    const prev = team;
    setTeam(next); setErr(null);
    const { error } = await supabase.from("clients").update({ team: next }).eq("id", clientId);
    if (error) { setTeam(prev); setErr(error.message); }
  };
  const add = (id: string) => {
    const p = people.find((x) => x.id === id);
    if (!p || !team) return;
    setAdding(false);
    void save([...team, { userId: p.id, name: p.name }]);
  };

  const n = team?.length ?? 0;
  return (
    <section data-sec="team" className="cw-card cw-box ctm">
      {head(
        team == null ? "Loading…" : n ? `Only ${n === 1 ? "this person" : `these ${n} people`} can log work on this client` : "Everyone can log work on this client",
        canEdit && options.length > 0 ? (
          <button className="cw-btn-primary is-sm" onClick={() => setAdding((v) => !v)}>{adding ? "Cancel" : "Add"}</button>
        ) : null,
      )}
      <div className={`ctm-add ${adding ? "is-on" : ""}`}><div>
        {adding && <Select value="" onChange={add} options={options} placeholder="Add someone to the team…" searchable aria-label="Add to the team" />}
      </div></div>
      {team && n === 0 && !adding && (
        <p className="ctm-empty">Nobody is set — anyone in the company can log time or shipments for it in the Calendar.{canEdit ? " Add people to keep it to them." : ""}</p>
      )}
      {n > 0 && (
        <div className="ctm-list">
          {team!.map((m, i) => {
            const nm = nameOf(m);
            return (
              <span key={m.userId} className="ctm-chip" style={{ ["--i" as string]: i }}>
                <i style={{ ["--h" as string]: HUE(nm) }}>{initials(nm)}</i>{nm}
                {canEdit && <button onClick={() => void save(team!.filter((x) => x.userId !== m.userId))} aria-label={`Take ${nm} off the team`}>×</button>}
              </span>
            );
          })}
        </div>
      )}
      {err && <p className="ctm-err">{err}</p>}
    </section>
  );
}
