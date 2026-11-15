/* =====================================================================
   BASE · Clients › a client's pop-up › Billing
   What this client has been invoiced and what's coming:
     · figures: invoiced, paid, waiting, not invoiced yet
     · Coming up: drafts, and the work / shipments logged and not on an
       invoice yet (an estimate at the client's rate)
     · Invoices: every one sent (paid / waiting / late / void), with a mark
       when it opened a contract or a project for the client (138)
     · Time by service: the hours logged for each of their services
       (Calendar › client work › "on which of their services"), who did them
       and how much is already invoiced.
   Opening an invoice goes to Billing with it open.
   ===================================================================== */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../../components/api/supabase";
import { hourlyRate, loadCatalog, loadClients, money, round2, stateOf, STATE_LABEL, todayIso, fmtDate, hrs, type CatItem, type BClient, type InvState } from "../billing/billingApi";
import "./ClientBilling.css";

interface Inv { id: string; number: string; status: string; issue_date: string; due_date: string | null; paid_date: string | null; net: number; amount: number; source: string }
interface Ent { id: string; user_id: string; date: string; hours: number; kind: string; project_id: string | null; invoice_id: string | null; quantity: number; unit_price: number; product_id: string | null; name: string }
interface Proj { id: string; service_id: string | null; status: string; source_invoice_id: string | null }

const P = {
  doc: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  check: "M20 6 9 17l-5-5",
  wait: "M12 8v4l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  box: "M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8",
  go: "M9 18l6-6-6-6",
  pen: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  spark: "M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z",
};
const Ico = ({ d, s = 16 }: { d: string; s?: number }) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const SEG = ["#12b57f", "#3c7fd0", "#e0a13c", "#9b6fd0", "#e0798c", "#1a9e9a", "#7d8b84", "#5b6ee1"];
const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

export default function ClientBilling({ clientId, projectIds }: { clientId: string; projectIds: string[] }) {
  const navigate = useNavigate();
  const [invs, setInvs] = useState<Inv[] | null>(null);
  const [ents, setEnts] = useState<Ent[]>([]);
  const [projs, setProjs] = useState<Proj[]>([]);
  const [opened, setOpened] = useState<Record<string, { products: number; services: number }>>({});
  const [catalog, setCatalog] = useState<CatItem[]>([]);
  const [client, setClient] = useState<BClient | null>(null);
  const [people, setPeople] = useState<Record<string, string>>({});
  const [invTab, setInvTab] = useState<"all" | InvState>("all");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const or = [`client_id.eq.${clientId}`, ...(projectIds.length ? [`project_id.in.(${projectIds.join(",")})`] : [])].join(",");
        const [{ data: iv, error: e1 }, { data: ce, error: e2 }, { data: pj }, { data: pr }, cat, cls] = await Promise.all([
          supabase.from("invoices").select("id, number, status, issue_date, due_date, paid_date, net, amount, source, period").or(or),
          supabase.from("calendar_entries").select("id, user_id, entry_date, billable, start_min, end_min, kind, project_id, invoice_id, quantity, unit_price, product_id, name, status")
            .eq("client_id", clientId).in("kind", ["client_work", "client_nonbillable", "shipment"]).neq("status", "cancelled").order("entry_date", { ascending: false }).limit(5000),
          supabase.from("projects").select("*").eq("client_id", clientId),
          supabase.from("profiles").select("id, first_name, last_name, full_name, email"),
          loadCatalog(), loadClients(),
        ]);
        if (e1 || e2) throw new Error((e1 ?? e2)!.message);
        if (!alive) return;
        setInvs(((iv ?? []) as any[]).map((r) => ({
          id: r.id, number: r.number || r.period || "—", status: r.status ?? "sent", issue_date: (r.issue_date ?? r.period ?? "").slice(0, 10), due_date: r.due_date ?? null,
          paid_date: r.paid_date ?? null, net: Number(r.net) || 0, amount: Number(r.amount) || 0, source: r.source ?? "manual",
        })).sort((a, b) => (a.issue_date < b.issue_date ? 1 : -1)));
        setEnts(((ce ?? []) as any[]).map((r) => ({
          id: r.id, user_id: r.user_id, date: r.entry_date ?? "", hours: Number(r.billable) || Math.max(0, ((Number(r.end_min) || 0) - (Number(r.start_min) || 0)) / 60),
          kind: r.kind, project_id: r.project_id ?? null, invoice_id: r.invoice_id ?? null, quantity: Number(r.quantity) || 0, unit_price: Number(r.unit_price) || 0, product_id: r.product_id ?? null, name: r.name ?? "",
        })));
        setProjs(((pj ?? []) as any[]).map((p) => ({ id: p.id, service_id: p.service_id ?? null, status: p.status ?? "open", source_invoice_id: p.source_invoice_id ?? null })));
        setPeople(Object.fromEntries(((pr ?? []) as any[]).map((p) => [p.id, [p.first_name, p.last_name].filter(Boolean).join(" ") || p.full_name || p.email || "Someone"])));
        setCatalog(cat);
        setClient(cls.find((c) => c.id === clientId) ?? null);
        // what each invoice opened (138): missing column → nothing
        const ids = ((iv ?? []) as any[]).map((r) => r.id);
        if (ids.length) {
          const [{ data: a }, { data: b }] = await Promise.all([
            supabase.from("client_products").select("source_invoice_id").in("source_invoice_id", ids),
            supabase.from("projects").select("source_invoice_id").in("source_invoice_id", ids),
          ]);
          const o: Record<string, { products: number; services: number }> = {};
          ((a ?? []) as any[]).forEach((r) => { (o[r.source_invoice_id] ??= { products: 0, services: 0 }).products++; });
          ((b ?? []) as any[]).forEach((r) => { (o[r.source_invoice_id] ??= { products: 0, services: 0 }).services++; });
          if (alive) setOpened(o);
        }
      } catch (x: any) { if (alive) { setErr(x?.message ?? String(x)); setInvs([]); } }
    })();
    return () => { alive = false; };
  }, [clientId, projectIds.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const today = todayIso();
  const rate = useMemo(() => hourlyRate(client ?? undefined, catalog), [client, catalog]);
  const svcName = (pid: string | null) => {
    if (!pid) return "General";
    const p = projs.find((x) => x.id === pid);
    return (p?.service_id && catalog.find((c) => c.kind === "service" && c.id === p.service_id)?.name) || "Project";
  };
  const shipValue = (e: Ent) => (e.quantity || 1) * (e.unit_price || catalog.find((c) => c.kind === "product" && c.id === e.product_id)?.price || 0);

  const sent = (invs ?? []).filter((i) => i.status !== "draft");
  const drafts = (invs ?? []).filter((i) => i.status === "draft");
  const st = (i: Inv) => stateOf({ status: i.status as any, due_date: i.due_date ?? i.issue_date }, today);
  const live = sent.filter((i) => i.status !== "void");
  const invoiced = round2(live.reduce((s, i) => s + i.amount, 0));
  const paid = round2(live.filter((i) => i.status === "paid").reduce((s, i) => s + i.amount, 0));
  const waiting = round2(invoiced - paid);
  const late = live.filter((i) => st(i) === "overdue");
  // logged, not on an invoice yet (up to today)
  const unbilled = ents.filter((e) => !e.invoice_id && e.date <= today && (e.kind === "client_work" || e.kind === "shipment"));
  const unHours = round2(unbilled.filter((e) => e.kind === "client_work").reduce((s, e) => s + e.hours, 0));
  const unShip = unbilled.filter((e) => e.kind === "shipment");
  const unValue = round2(unHours * rate + unShip.reduce((s, e) => s + shipValue(e), 0));
  const unSince = unbilled.map((e) => e.date).sort()[0];

  const svcRows = useMemo(() => {
    const m = new Map<string, Ent[]>();
    ents.filter((e) => e.kind !== "shipment").forEach((e) => { const k = e.project_id ?? ""; m.set(k, [...(m.get(k) ?? []), e]); });
    return [...m].map(([pid, es]) => {
      const total = round2(es.reduce((s, e) => s + e.hours, 0));
      const billed = round2(es.filter((e) => e.invoice_id).reduce((s, e) => s + e.hours, 0));
      const nb = round2(es.filter((e) => e.kind === "client_nonbillable").reduce((s, e) => s + e.hours, 0));
      const who = new Map<string, number>();
      es.forEach((e) => who.set(e.user_id, (who.get(e.user_id) ?? 0) + e.hours));
      const p = projs.find((x) => x.id === pid);
      return { pid, name: svcName(pid || null), status: p?.status ?? null, total, billed, nb, toBill: round2(total - billed - nb), last: es.map((e) => e.date).sort().slice(-1)[0] ?? "",
        who: [...who].sort((a, b) => b[1] - a[1]).map(([u, h]) => ({ u, name: people[u] ?? "Someone", h: round2(h) })), es };
    }).sort((a, b) => (a.pid === "" ? 1 : b.pid === "" ? -1 : b.total - a.total));
  }, [ents, projs, catalog, people]); // eslint-disable-line react-hooks/exhaustive-deps
  const maxSvc = Math.max(1, ...svcRows.map((r) => r.total));
  const colorOf = (name: string) => SEG[[...new Set(svcRows.flatMap((r) => r.who.map((w) => w.name)))].indexOf(name) % SEG.length] ?? SEG[0];

  const shownInvs = sent.filter((i) => invTab === "all" || st(i) === invTab);
  const counts = { all: sent.length, unpaid: sent.filter((i) => st(i) === "unpaid").length, overdue: late.length, paid: sent.filter((i) => st(i) === "paid").length, void: sent.filter((i) => st(i) === "void").length };
  const openInv = (id: string) => navigate(`/billing?invoice=${id}`);
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  if (!invs) return <div className="cbl"><div className="cbl-skel" /><div className="cbl-skel" /></div>;

  return (
    <div className="cbl">
      {err && <p className="cbl-err">{err}</p>}
      <div className="cbl-figs">
        <div className="cbl-fig is-pine"><span><Ico d={P.doc} s={15} />Invoiced</span><b>{money(invoiced)}</b><small>{live.length} invoice{live.length === 1 ? "" : "s"}</small></div>
        <div className="cbl-fig"><span><Ico d={P.check} s={15} />Paid</span><b>{money(paid)}</b><small>{invoiced ? `${Math.round((paid / invoiced) * 100)}% of it` : "nothing yet"}</small><i><s style={{ width: `${invoiced ? (paid / invoiced) * 100 : 0}%` }} /></i></div>
        <div className={`cbl-fig ${late.length ? "is-late" : ""}`}><span><Ico d={P.wait} s={15} />Waiting</span><b>{money(waiting)}</b><small>{late.length ? `${late.length} late` : waiting ? "on time" : "nothing owed"}</small></div>
        <div className="cbl-fig is-green"><span><Ico d={P.clock} s={15} />Not invoiced yet</span><b>{money(unValue)}</b><small>{unHours ? `${hrs(unHours)}` : ""}{unHours && unShip.length ? " · " : ""}{unShip.length ? `${unShip.length} shipment${unShip.length === 1 ? "" : "s"}` : ""}{!unHours && !unShip.length ? "all invoiced" : ""}</small></div>
      </div>

      <section className="cbl-card">
        <header><h3>Coming up</h3><small>What goes on their next invoices</small></header>
        {drafts.length === 0 && !unbilled.length ? <p className="cbl-none">Nothing waiting to be invoiced.</p> : (
          <div className="cbl-rows">
            {drafts.map((i) => (
              <button key={i.id} type="button" className="cbl-row" onClick={() => openInv(i.id)}>
                <span className="cbl-ico is-draft"><Ico d={P.pen} s={15} /></span>
                <span className="cbl-t"><b>Draft {i.number}{opened[i.id] && <em className="cbl-opens" title="Opens a contract / project for this client"><Ico d={P.spark} s={11} />new</em>}</b><small>{i.source === "auto" ? "Proposed automatically" : "Written by hand"} · {fmtDate(i.issue_date)}</small></span>
                <b className="cbl-amt">{money(i.amount)}</b>
                <span className="cbl-go"><Ico d={P.go} s={14} /></span>
              </button>
            ))}
            {unbilled.length > 0 && (
              <button type="button" className="cbl-row" onClick={() => navigate("/billing?view=toinvoice")}>
                <span className="cbl-ico is-work"><Ico d={P.clock} s={15} /></span>
                <span className="cbl-t"><b>Logged, not on an invoice yet</b><small>{[unHours ? `${hrs(unHours)} of work` : "", unShip.length ? `${unShip.length} shipment${unShip.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")}{unSince ? ` · since ${fmtDate(unSince)}` : ""}</small></span>
                <b className="cbl-amt is-soft">≈ {money(unValue)}</b>
                <span className="cbl-go"><Ico d={P.go} s={14} /></span>
              </button>
            )}
          </div>
        )}
      </section>

      <section className="cbl-card">
        <header>
          <h3>Invoices</h3>
          <div className="cbl-seg" role="tablist">
            {(["all", "unpaid", "overdue", "paid", "void"] as const).filter((k) => k === "all" || counts[k]).map((k) => (
              <button key={k} type="button" className={invTab === k ? "is-on" : ""} onClick={() => setInvTab(k)}>{k === "all" ? "All" : STATE_LABEL[k]}<i>{counts[k]}</i></button>
            ))}
          </div>
        </header>
        {shownInvs.length === 0 ? <p className="cbl-none">{sent.length ? "None here." : "No invoice sent to this client yet."}</p> : (
          <div className="cbl-rows">
            {shownInvs.map((i) => {
              const s = st(i);
              const o = opened[i.id];
              return (
                <button key={i.id} type="button" className={`cbl-row is-${s}`} onClick={() => openInv(i.id)}>
                  <span className={`cbl-ico is-${s}`}><Ico d={s === "paid" ? P.check : P.doc} s={15} /></span>
                  <span className="cbl-t">
                    <b>{i.number}{o && (o.products || o.services) ? <em className="cbl-opens" title={`Opened ${[o.products ? `${o.products} contract${o.products === 1 ? "" : "s"}` : "", o.services ? `${o.services} project${o.services === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ")}`}><Ico d={P.spark} s={11} />{o.products ? "new contract" : "new project"}</em> : null}</b>
                    <small>Issued {fmtDate(i.issue_date)}{s === "paid" && i.paid_date ? ` · paid ${fmtDate(i.paid_date)}` : i.due_date && s !== "void" ? ` · due ${fmtDate(i.due_date)}` : ""}</small>
                  </span>
                  <i className={`cbl-pill is-${s}`}>{STATE_LABEL[s]}</i>
                  <b className="cbl-amt">{money(i.amount)}</b>
                  <span className="cbl-go"><Ico d={P.go} s={14} /></span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section className="cbl-card">
        <header><h3>Time by service</h3><small>Logged in the Calendar for this client</small></header>
        {svcRows.length === 0 ? <p className="cbl-none">No time logged for this client yet.</p> : (
          <div className="cbl-svcs">
            {svcRows.map((r) => {
              const isOpen = open.has(r.pid);
              return (
                <div key={r.pid || "general"} className={`cbl-svc ${isOpen ? "is-open" : ""}`}>
                  <button type="button" className="cbl-svc-h" onClick={() => toggle(r.pid)} aria-expanded={isOpen}>
                    <span className={`cbl-ico ${r.pid ? "is-svc" : "is-gen"}`}>{initials(r.name)}</span>
                    <span className="cbl-t"><b>{r.name}{r.status === "on_hold" ? <em className="cbl-tag">On hold</em> : r.status === "closed" ? <em className="cbl-tag">Closed</em> : null}</b>
                      <small>{r.who.length} {r.who.length === 1 ? "person" : "people"}{r.last ? ` · last ${fmtDate(r.last)}` : ""}</small></span>
                    <span className="cbl-bar"><u style={{ width: `${(r.total / maxSvc) * 100}%` }}>{r.who.map((w) => <s key={w.u} style={{ flexGrow: w.h, background: colorOf(w.name) }} />)}</u></span>
                    <span className="cbl-svc-n"><b>{hrs(r.total)}</b><small>{r.toBill > 0 ? `${hrs(r.toBill)} to invoice` : r.billed ? "all invoiced" : r.nb ? "not billed" : ""}</small></span>
                    <span className="cbl-go is-chev"><Ico d="M6 9l6 6 6-6" s={14} /></span>
                  </button>
                  <div className="cbl-reveal"><div>
                    <div className="cbl-who">
                      {r.who.map((w) => (
                        <span key={w.u}><i style={{ background: colorOf(w.name) }}>{initials(w.name)}</i>{w.name}<b>{hrs(w.h)}</b></span>
                      ))}
                    </div>
                    <div className="cbl-split">
                      <span><i className="is-b" />Invoiced <b>{hrs(r.billed)}</b></span>
                      <span><i className="is-t" />To invoice <b>{hrs(r.toBill)}</b></span>
                      {r.nb > 0 && <span><i className="is-n" />Not billable <b>{hrs(r.nb)}</b></span>}
                    </div>
                    <div className="cbl-ents">
                      {r.es.slice(0, 12).map((e) => (
                        <div key={e.id}><span>{fmtDate(e.date)}</span><span>{people[e.user_id] ?? "Someone"}</span><b>{hrs(e.hours)}</b>
                          <em className={e.kind === "client_nonbillable" ? "is-n" : e.invoice_id ? "is-b" : "is-t"}>{e.kind === "client_nonbillable" ? "Not billable" : e.invoice_id ? "Invoiced" : "To invoice"}</em></div>
                      ))}
                      {r.es.length > 12 && <small className="cbl-more">+{r.es.length - 12} more in Billing › Time</small>}
                    </div>
                  </div></div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
