/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../api/supabase";
import "./SavedDaysModal.css";

type Line = "consultor" | "supervision";

interface Movement {
  user_id: string;
  client_id: string;
  project_id: string;
  line: Line;
  delta: number;
  reason: string | null;
  created_at: string;
}

interface Props {
  /** True for boss / consultancy_manager: they see everyone. Otherwise only own. */
  seesAll: boolean;
  myUserId: string | null;
  people: Record<string, string>;
  clientNames: Record<string, string>;
  projectNames: Record<string, string>;
  onClose: () => void;
}

const d2 = (n: number) => (+n.toFixed(2)).toLocaleString();
const baDate = (iso: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};
const lineLabel: Record<Line, string> = { consultor: "Consultancy", supervision: "Supervision" };

export default function SavedDaysModal({ seesAll, myUserId, people, clientNames, projectNames, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose]);

  const [moves, setMoves] = useState<Movement[]>([]);
  const [loading, setLoading] = useState(true);
  const [openUser, setOpenUser] = useState<string | null>(null);
  const [originOf, setOriginOf] = useState<string | null>(null); // "user|client|project|line"

  useEffect(() => {
    (async () => {
      setLoading(true);
      let q = supabase
        .from("locker_movements")
        .select("user_id, client_id, project_id, line, delta, reason, created_at")
        .not("user_id", "is", null)
        .order("created_at", { ascending: false });
      if (!seesAll && myUserId) q = q.eq("user_id", myUserId);
      const { data } = await q;
      setMoves(((data ?? []) as any[]).map((m) => ({ ...m, delta: Number(m.delta) || 0 })));
      setLoading(false);
    })();
  }, [seesAll, myUserId]);

  // Group: user -> client -> project -> line -> { balance, movements }
  const tree = useMemo(() => {
    type Leaf = { balance: number; moves: Movement[] };
    const byUser: Record<string, { total: number; clients: Record<string, { total: number; projects: Record<string, Record<Line, Leaf>> }> }> = {};
    moves.forEach((m) => {
      const u = (byUser[m.user_id] ??= { total: 0, clients: {} });
      u.total += m.delta;
      const c = (u.clients[m.client_id] ??= { total: 0, projects: {} });
      c.total += m.delta;
      const p = (c.projects[m.project_id] ??= { consultor: { balance: 0, moves: [] }, supervision: { balance: 0, moves: [] } });
      p[m.line].balance += m.delta;
      p[m.line].moves.push(m);
    });
    return byUser;
  }, [moves]);

  const users = Object.entries(tree).sort((a, b) => b[1].total - a[1].total);
  const grandTotal = users.reduce((s, [, u]) => s + u.total, 0);

  return createPortal(
    <div className="sd-backdrop" onMouseDown={onClose}>
      <div className="sd" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Saved days bank">
        <header className="sd-head">
          <div className="sd-head-main">
            <span className="sd-ico" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 4v5M12 13h.01" />
              </svg>
            </span>
            <div className="sd-id">
              <h2 className="sd-name">Saved days bank</h2>
              <span className="sd-sub">{seesAll ? "All consultants" : "Your saved days"} · {d2(grandTotal)}d banked</span>
            </div>
          </div>
          <button className="sd-x" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="sd-body">
          {loading ? (
            <p className="sd-empty">Loading…</p>
          ) : users.length === 0 ? (
            <p className="sd-empty">No saved days yet. Days appear here when a manager trims entries in Billing.</p>
          ) : (
            <div className="sd-list">
              {users.map(([uid, u]) => {
                const open = openUser === uid;
                return (
                  <div className={`sd-urow ${open ? "is-open" : ""}`} key={uid}>
                    <button className="sd-urow-main" onClick={() => setOpenUser(open ? null : uid)}>
                      <span className="sd-av">{(people[uid] ?? "?").charAt(0).toUpperCase()}</span>
                      <span className="sd-uname">{people[uid] ?? "Unknown"}</span>
                      <span className="sd-utot">{d2(u.total)}<em>d</em></span>
                      <span className={`sd-chev ${open ? "is-open" : ""}`}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
                      </span>
                    </button>
                    {open && (
                      <div className="sd-clients">
                        {Object.entries(u.clients).sort((a, b) => b[1].total - a[1].total).map(([cid, c]) => (
                          <div className="sd-client" key={cid}>
                            <div className="sd-client-h">
                              <span>{clientNames[cid] ?? "Unknown client"}</span>
                              <b>{d2(c.total)}d</b>
                            </div>
                            {Object.entries(c.projects).map(([pid, byLine]) =>
                              (["consultor", "supervision"] as Line[]).map((ln) => {
                                const leaf = byLine[ln];
                                if (leaf.balance <= 0.001 && leaf.moves.length === 0) return null;
                                if (Math.abs(leaf.balance) < 0.001 && leaf.moves.length === 0) return null;
                                const key = `${uid}|${cid}|${pid}|${ln}`;
                                const showOrigin = originOf === key;
                                return (
                                  <div className="sd-proj" key={key}>
                                    <button className="sd-proj-row" onClick={() => setOriginOf(showOrigin ? null : key)}>
                                      <span className={`sd-ptag is-${ln}`}>{lineLabel[ln]}</span>
                                      <span className="sd-pname">{projectNames[pid] ?? "Project"}</span>
                                      <span className="sd-pdays">{d2(leaf.balance)}<em>d</em></span>
                                      <span className="sd-origin-toggle">{showOrigin ? "Hide" : "Where from"}</span>
                                    </button>
                                    {showOrigin && (
                                      <div className="sd-origin">
                                        {leaf.moves.map((m, i) => (
                                          <div className={`sd-omove ${m.delta < 0 ? "is-out" : "is-in"}`} key={i}>
                                            <span className="sd-odelta">{m.delta > 0 ? "+" : ""}{d2(m.delta)}d</span>
                                            <span className="sd-oreason">{m.reason ?? "adjustment"}</span>
                                            <span className="sd-odate">{baDate(m.created_at)}</span>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                );
                              })
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}