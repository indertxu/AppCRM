/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useState, useEffect, useRef } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { supabase } from "../../api/supabase";
import { periodForDate, cutoffOf, type Cutoffs } from "../calendar/billingPeriods";
import DatePicker from "../../framework/DatePicker";
import Select from "../../framework/Select";
import { downloadBlob, sheetToXlsx, type XCell, type XStyle } from "../../framework/exportFile";
import "./BillingPanel.css";

export interface BiEntry {
  id: string;
  userId: string;
  projectId: string;
  date: string;
  billable: number;
  status: string;
  line: string;
  billingPeriod?: string | null;
}
export interface BiProj {
  id: string;
  clientId: string;
  typeId: string;
  rate: number;
  supervision: number;
  taxed: boolean;
  taxRate: number;
  legalName: string;
  vat: string;
  address: any;
  contacts: any[];
  team: { userId?: string; role?: string }[];
}

interface Props {
  entries: BiEntry[];
  projects: Record<string, BiProj>;
  clientNames: Record<string, string>;
  typeNames: Record<string, string>;
  people: Record<string, string>;
  supRoles: Set<string>;
  hourProjects?: Set<string>;
  anchor?: Date;
  cutoffs?: Cutoffs;
  defaultCutoffDay?: number;
}

type Line = "consultor" | "supervision" | "connector";
const lineLabel: Record<Line, string> = {
  consultor: "Consultancy",
  supervision: "Supervision",
  connector: "Connector",
};
type Phase = "tobill" | "sent" | "paid" | "history";
type SortKey = "amount_desc" | "amount_asc" | "date_desc" | "date_asc" | "expired";

/**
 * Postal code from an address object, whatever the key is called
 * (zip, postcode, postal_code, postalCode, zipCode, cp, codigo_postal…).
 * Falls back to a 5-digit Spanish code written inside the street text.
 */
function postalOf(a: any): string {
  if (!a || typeof a !== "object") return "";
  if (a.postalCode) return String(a.postalCode).trim(); // how NewClientForm stores it
  for (const [k, v] of Object.entries(a)) {
    if (v == null || v === "" || typeof v === "object") continue;
    if (/zip|post|^cp$|c[oó]digo|^code$/i.test(k)) return String(v).trim();
  }
  const m = String(a.street ?? a.line1 ?? a.address ?? "").match(/\b\d{5}\b/);
  return m ? m[0] : "";
}

function fmtAddress(a: any): string {
  if (!a) return "";
  if (typeof a === "string") return a;
  const parts = [a.street, a.number, a.details, a.city, postalOf(a), a.country].filter(Boolean);
  return parts.join(", ");
}
function billingContact(contacts: any[]): { name: string; email: string } | null {
  if (!Array.isArray(contacts) || contacts.length === 0) return null;
  const b = contacts.find((c) => c?.billing) ?? contacts[0];
  return { name: [b?.name, b?.position].filter(Boolean).join(" · "), email: b?.email ?? "" };
}
/** Money formatter: thousands separator + two decimals. */
const eur = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ===================================================================
   Presentation helpers. Same language as the Team and Backlog tabs and
   the consultant modal: count-ups, a sweeping arc, cursor spotlight.
   =================================================================== */
const bnVars = (o: Record<string, string | number>) => o as CSSProperties;
const bnReduced = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
/** "2026-09-14" → "14 Sep 2026" (display only). */
const bnDate = (iso: string) => {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};
function useBnCount(target: number, ms = 1100) {
  const [value, setValue] = useState(() => (bnReduced() ? target : 0));
  const from = useRef(value);
  useEffect(() => {
    if (bnReduced()) { from.current = target; setValue(target); return; }
    let raf = 0;
    const start = from.current;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      const e = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
      const cur = start + (target - start) * e;
      from.current = cur;
      setValue(cur);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}
function BnCount({ value, fmt = (n: number) => Math.round(n).toLocaleString() }: { value: number; fmt?: (n: number) => string }) {
  return <>{fmt(useBnCount(value))}</>;
}
function useBnArmed(ms: number) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setArmed(true), bnReduced() ? 0 : ms);
    return () => window.clearTimeout(t);
  }, [ms]);
  return armed;
}
function bnSpot(e: ReactPointerEvent<HTMLElement>) {
  if (e.pointerType !== "mouse") return;
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-spot]");
  if (!el) return;
  const r = el.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  el.style.setProperty("--mx", `${x}px`);
  el.style.setProperty("--my", `${y}px`);
  if (el.dataset.spot === "tilt") {
    el.style.setProperty("--ry", `${(x / r.width - 0.5) * 6}deg`);
    el.style.setProperty("--rx", `${(0.5 - y / r.height) * 6}deg`);
  }
}
const BN_ICON = {
  out: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4",
  paid: "M20 6L9 17l-5-5",
  sent: "M22 2L11 13M22 2l-7 20-4-9-9-4z",
  late: "M12 7.5V12l3 2M20.5 12a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0z",
  cal: "M8 3v3M16 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
  warn: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  chev: "M9 6l6 6-6 6",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  xls: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13l3 4M12 13l-3 4",
  x: "M18 6L6 18M6 6l12 12",
  grip: "M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01",
  empty: "M4 7l8-4 8 4-8 4zM4 12l8 4 8-4M4 17l8 4 8-4",
  edit: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
};
function BnIcon({ d, w = 2 }: { d: string; w?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
const BN_ARC = "M16 70 A54 54 0 0 1 124 70";

interface Invoice {
  id: string; projectId: string; period: string;
  net: number; amount: number; days: number;
  sentDate: string; dueDate: string; paidDate: string;
  status: string;
}
interface Bill {
  key: string;
  projectId: string;
  period: string;
  clientId: string;
  typeId: string;
  type: string;
  legalName: string;
  vat: string;
  address: string;
  contact: { name: string; email: string } | null;
  rate: number;
  supervisionRate: number;
  taxed: boolean;
  taxRate: number;
  lines: Record<Line, number>;
  rows: { id: string; date: string; userId: string; days: number; line: Line; status: string; moved?: boolean }[];
}

export default function BillingPanel({
  entries, projects, clientNames, typeNames, people, supRoles,
  hourProjects = new Set(), anchor = new Date(), cutoffs = {}, defaultCutoffDay = 0,
}: Props) {
  /** "h" if the bill's project is billed by the hour, otherwise "d". */
  const unitOf = (projectId: string) => (hourProjects.has(projectId) ? "h" : "d");
  const [open, setOpen] = useState<string | null>(null);
  /** Bills ticked for Excel export (To-bill tab only). Keyed by bill.key. */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  /** Off by default: the checkbox column only appears once the user opts in. */
  const [selectMode, setSelectMode] = useState(false);
  // Drag & drop: local period overrides + the entry currently being dragged
  const [localMoves, setLocalMoves] = useState<Record<string, string>>({});
  const [dragEntry, setDragEntry] = useState<{ id: string; projectId: string; fromPeriod: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [status, setStatus] = useState<"billed" | "scheduled" | "all">("billed");
  interface BillingAlert { id: string; project_id: string | null; period: string; entry_date: string; billable: number; billing_line: string | null; attempted_by: string | null; created_at: string }
  const [alerts, setAlerts] = useState<BillingAlert[]>([]);
  const [showAlerts, setShowAlerts] = useState(false);
  interface StatusLog { id: string; invoice_id: string | null; project_id: string | null; period: string; from_status: string | null; to_status: string; amount: number | null; changed_by: string | null; created_at: string }
  const [statusLog, setStatusLog] = useState<StatusLog[]>([]);
  const loadStatusLog = () => {
    supabase.from("invoice_status_log").select("*").order("created_at", { ascending: false }).limit(200)
      .then(({ data }) => setStatusLog((data ?? []) as StatusLog[]));
  };
  // Fix dialog: an invoice, its live bill, and an editable per-line, per-person day split.
  type FixCell = { line: Line; userId: string; days: string };
  const [fixing, setFixing] = useState<{ inv: Invoice; bill: Bill; cells: FixCell[] } | null>(null);
  const [phase, setPhase] = useState<Phase>("tobill");
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [paymentDays, setPaymentDays] = useState(30);
  const [busy, setBusy] = useState<string | null>(null);

  // Sort + filters
  const [sortKey, setSortKey] = useState<SortKey>("amount_desc");
  const [query, setQuery] = useState("");
  const [fCompany, setFCompany] = useState("");
  const [fType, setFType] = useState("");

  // Editable cutoff for the current period, right in the hero
  const [cutoffOpen, setCutoffOpen] = useState(false);
  const [localCutoffs, setLocalCutoffs] = useState<Cutoffs>(cutoffs);
  useEffect(() => { setLocalCutoffs(cutoffs); }, [cutoffs]);

  // The billing period follows the month picked in the page header, so you can
  // step back and see what was sent, paid, or still to bill in an earlier month.
  const period = `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, "0")}`;
  // End of the selected billing month — the "as of" date for the point-in-time
  // view. Everything below judges each invoice's status as it stood then.
  const asOfDate = (() => {
    const [y, m] = period.split("-").map(Number);
    return `${y}-${String(m).padStart(2, "0")}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
  })();
  /** Was this invoice already sent by the as-of date? */
  const wasSentBy = (i: Invoice) => !!i.sentDate && i.sentDate <= asOfDate;
  /** Was it actually paid by the as-of date? */
  const wasPaidBy = (i: Invoice) => i.status === "paid" && !!i.paidDate && i.paidDate <= asOfDate;

  useEffect(() => {
    (async () => {
      // Alerts live at most two months — clear out anything older on load.
      const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 2);
      try { await supabase.from("billing_alerts").delete().lt("created_at", cutoff.toISOString()); } catch (e) { console.error(e); }
      const { data } = await supabase.from("billing_alerts").select("*").order("created_at", { ascending: false });
      setAlerts((data ?? []) as BillingAlert[]);
    })();
    loadStatusLog();
  }, []);

  // Dismissing an alert deletes it for good, rather than just hiding it.
  const dismissAlert = async (id: string) => {
    await supabase.from("billing_alerts").delete().eq("id", id);
    setAlerts((a) => a.filter((x) => x.id !== id));
  };
  const dismissAllAlerts = async () => {
    const ids = alerts.map((a) => a.id);
    if (!ids.length) return;
    await supabase.from("billing_alerts").delete().in("id", ids);
    setAlerts([]);
  };

  const periodLabel = (p: string) => {
    const [y, m] = p.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleString("en", { month: "short", year: "numeric" });
  };

  useEffect(() => {
    (async () => {
      const { data: inv } = await supabase.from("invoices").select("*");
      setInvoices(((inv ?? []) as any[]).map((r) => ({
        id: r.id, projectId: r.project_id, period: r.period,
        net: Number(r.net) || 0, amount: Number(r.amount) || 0, days: Number(r.days) || 0,
        sentDate: r.sent_date ?? "", dueDate: r.due_date ?? "", paidDate: r.paid_date ?? "",
        status: r.status ?? "sent",
      })));
      const { data: cfg } = await supabase.from("billing_settings").select("*").eq("id", "default").maybeSingle();
      if (cfg) setPaymentDays(Number(cfg.payment_days) || 30);
      setLoaded(true);
    })();
  }, []);

  const savePaymentDays = async (pay: number) => {
    setPaymentDays(pay);
    await supabase.from("billing_settings").upsert({ id: "default", payment_days: pay });
  };
  const saveCutoff = async (iso: string) => {
    setLocalCutoffs((c) => ({ ...c, [period]: iso }));
    setCutoffOpen(false);
    await supabase.from("billing_periods").upsert({ period, cutoff_date: iso });
  };

  const invByKey = useMemo(() => {
    const m: Record<string, Invoice> = {};
    invoices.forEach((i) => { m[`${i.projectId}|${i.period}`] = i; });
    return m;
  }, [invoices]);
  /** Has this bill been invoiced-and-sent by the as-of date? If not, it's still to bill. */
  const billedBy = (key: string) => {
    const inv = invByKey[key];
    return !!inv && !!inv.sentDate && inv.sentDate <= asOfDate;
  };

  const lineOf = (p: BiProj, line: string, _userId: string): Line => {
    // The billing line follows what the user picked when logging (consultor /
    // connector / project management), NOT their role on the project. Someone who
    // is the PM can still log consultancy work at the consultancy rate if they choose to.
    if (line === "connector") return "connector";
    if (line === "supervision") return "supervision";
    return "consultor";
  };
  const counts = (e: BiEntry) =>
    status === "all" ? e.status !== "cancelled"
    : status === "billed" ? e.status === "confirmed"
    : e.status === "planned";

  const bills = useMemo<Bill[]>(() => {
    const acc: Record<string, Bill> = {};
    const ensure = (p: BiProj, per: string): Bill => {
      const key = `${p.id}|${per}`;
      if (!acc[key]) {
        acc[key] = {
          key, projectId: p.id, period: per,
          clientId: p.clientId,
          typeId: p.typeId,
          type: typeNames[p.typeId] || "No project type",
          legalName: p.legalName || clientNames[p.clientId] || "—",
          vat: p.vat,
          address: fmtAddress(p.address),
          contact: billingContact(p.contacts),
          rate: p.rate,
          supervisionRate: p.supervision,
          taxed: p.taxed,
          taxRate: p.taxRate,
          lines: { consultor: 0, supervision: 0, connector: 0 },
          rows: [],
        };
      }
      return acc[key];
    };

    entries.forEach((e) => {
      if (!counts(e) || !e.projectId || !e.userId || !e.date) return;
      if (e.line === "closure") return;
      const p = projects[e.projectId];
      if (!p) return;
      // A moved entry keeps its project but bills in an overridden period.
      const override = localMoves[e.id] ?? e.billingPeriod ?? null;
      const per = override || periodForDate(e.date, localCutoffs, defaultCutoffDay);
      const bill = ensure(p, per);
      const bucket = lineOf(p, e.line, e.userId);
      bill.lines[bucket] += e.billable;
      bill.rows.push({ id: e.id, date: e.date, userId: e.userId, days: e.billable, line: bucket, status: e.status, moved: !!override && override !== periodForDate(e.date, localCutoffs, defaultCutoffDay) });
    });

    return Object.values(acc)
      // A bill needs at least one row AND some billable value. Periods that
      // hold only non-billable work (internal, demos, client prep) would
      // otherwise appear as phantom 0.00 invoices in the To-bill tab.
      .filter((b) => b.rows.length > 0
        && (b.lines.consultor + b.lines.supervision + b.lines.connector) > 0)
      .map((b) => ({ ...b, rows: b.rows.sort((x, y) => x.date.localeCompare(y.date)) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, projects, clientNames, typeNames, supRoles, status, localCutoffs, defaultCutoffDay, localMoves]);

  const net = (b: Bill) =>
    b.lines.consultor * b.rate + b.lines.connector * b.rate + b.lines.supervision * b.supervisionRate;
  const gross = (b: Bill) => net(b) * (b.taxed ? 1 + b.taxRate / 100 : 1);

  const billByKey = useMemo(() => {
    const m: Record<string, Bill> = {};
    bills.forEach((b) => { m[b.key] = b; });
    return m;
  }, [bills]);

  const responsibleFor = (b: Bill) => {
    const per: Record<string, { days: number; value: number }> = {};
    b.rows.forEach((r) => {
      if (!per[r.userId]) per[r.userId] = { days: 0, value: 0 };
      const rate = r.line === "supervision" ? b.supervisionRate : b.rate;
      per[r.userId].days += r.days;
      per[r.userId].value += r.days * rate;
    });
    return Object.entries(per).sort((a, b2) => b2[1].value - a[1].value);
  };

  const isoDate = (d: Date) => d.toISOString().slice(0, 10);
  const sendDateFor = (per: string) => new Date(`${cutoffOf(per, localCutoffs, defaultCutoffDay)}T00:00:00`);

  /** Append a row to the invoice status history (best-effort; never blocks the action). */
  const logStatus = async (o: { invoiceId?: string; projectId: string; period: string; from: string | null; to: string; amount?: number }) => {
    try {
      const { data: au } = await supabase.auth.getUser();
      await supabase.from("invoice_status_log").insert({
        invoice_id: o.invoiceId ?? null, project_id: o.projectId, period: o.period,
        from_status: o.from, to_status: o.to, amount: o.amount ?? null, changed_by: au?.user?.id ?? null,
      });
      loadStatusLog();
    } catch (e) { console.error("Could not log status change:", e); }
  };

  const markSent = async (b: Bill) => {
    setBusy(b.key);
    const sent = sendDateFor(b.period);
    const due = new Date(sent); due.setDate(due.getDate() + paymentDays);
    const rowDays = b.lines.consultor + b.lines.supervision + b.lines.connector;
    const payload = {
      project_id: b.projectId, period: b.period,
      net: +net(b).toFixed(2), amount: +gross(b).toFixed(2), days: rowDays,
      sent_date: isoDate(sent), due_date: isoDate(due), status: "sent", paid_date: null,
    };
    const { data } = await supabase.from("invoices").upsert(payload, { onConflict: "project_id,period" }).select().maybeSingle();
    if (data) {
      const inv: Invoice = {
        id: data.id, projectId: data.project_id, period: data.period,
        net: Number(data.net), amount: Number(data.amount), days: Number(data.days),
        sentDate: data.sent_date ?? "", dueDate: data.due_date ?? "", paidDate: "", status: data.status,
      };
      setInvoices((prev) => [...prev.filter((i) => !(i.projectId === inv.projectId && i.period === inv.period)), inv]);
      await logStatus({ invoiceId: inv.id, projectId: inv.projectId, period: inv.period, from: "tobill", to: "sent", amount: inv.amount });
    }
    setBusy(null);
  };
  /**
   * Recompute a already-sent/paid invoice to what its entries actually sum to
   * TODAY (respecting manual period moves, which the live bill already reflects).
   * Only net/amount/days change; status, dates and paid state are untouched.
   */
  const recomputeInvoice = async (inv: Invoice, b: Bill, override?: { consultor: number; supervision: number; connector: number }) => {
    const key = `${inv.projectId}|${inv.period}`;
    setBusy(key);
    const ln = override ?? b.lines;
    const days = +(ln.consultor + ln.supervision + ln.connector).toFixed(2);
    const newNet = +(ln.consultor * b.rate + ln.connector * b.rate + ln.supervision * b.supervisionRate).toFixed(2);
    const newAmount = +(newNet * (b.taxed ? 1 + b.taxRate / 100 : 1)).toFixed(2);
    const { error } = await supabase.from("invoices")
      .update({ net: newNet, amount: newAmount, days }).eq("id", inv.id);
    if (error) { alert(`Could not update invoice: ${error.message}`); setBusy(null); return; }
    setInvoices((prev) => prev.map((i) => i.id === inv.id ? { ...i, net: newNet, amount: newAmount, days } : i));
    setBusy(null);
  };

  // Build the editable per-line, per-person cells from a bill's entries.
  const cellsFromBill = (b: Bill): { line: Line; userId: string; days: string }[] => {
    const agg = new Map<string, number>(); // `${line}|${userId}` → days
    b.rows.forEach((r) => {
      const k = `${r.line}|${r.userId}`;
      agg.set(k, (agg.get(k) ?? 0) + r.days);
    });
    const order: Line[] = ["consultor", "supervision", "connector"];
    return [...agg.entries()]
      .map(([k, days]) => { const [line, userId] = k.split("|"); return { line: line as Line, userId, days: String(+days.toFixed(2)) }; })
      .sort((a, b2) => order.indexOf(a.line) - order.indexOf(b2.line) || (people[a.userId] ?? "").localeCompare(people[b2.userId] ?? ""));
  };
  // Open the Fix dialog pre-filled with the live (recomputed) split.
  const openFix = (inv: Invoice, b: Bill) => setFixing({ inv, bill: b, cells: cellsFromBill(b) });

  /** Recompute every mismatched invoice currently listed, one by one. */
  const recomputeMany = async (list: Invoice[]) => {
    const targets = list.map((inv) => {
      const comp = billByKey[`${inv.projectId}|${inv.period}`];
      if (!comp) return null;
      const liveAmount = +gross(comp).toFixed(2);
      return Math.abs(liveAmount - inv.amount) > 0.01 ? { inv, comp } : null;
    }).filter(Boolean) as { inv: Invoice; comp: Bill }[];
    if (targets.length === 0) return;
    if (!window.confirm(`Recompute ${targets.length} invoice${targets.length === 1 ? "" : "s"} to match their entries?\n\nSome may be marked paid. This updates each amount to what its entries now sum to.`)) return;
    for (const t of targets) {
      const days = +(t.comp.lines.consultor + t.comp.lines.supervision + t.comp.lines.connector).toFixed(2);
      const newNet = +net(t.comp).toFixed(2);
      const newAmount = +gross(t.comp).toFixed(2);
      const { error } = await supabase.from("invoices").update({ net: newNet, amount: newAmount, days }).eq("id", t.inv.id);
      if (error) { alert(`Stopped: could not update ${projName(t.inv.projectId)} ${t.inv.period}: ${error.message}`); break; }
      setInvoices((prev) => prev.map((i) => i.id === t.inv.id ? { ...i, net: newNet, amount: newAmount, days } : i));
    }
  };

  const togglePaid = async (inv: Invoice) => {
    setBusy(`${inv.projectId}|${inv.period}`);
    const nowPaid = inv.status !== "paid";
    const paid = nowPaid ? isoDate(new Date()) : null;
    await supabase.from("invoices").update({ status: nowPaid ? "paid" : "sent", paid_date: paid }).eq("id", inv.id);
    setInvoices((prev) => prev.map((i) => i.id === inv.id ? { ...i, status: nowPaid ? "paid" : "sent", paidDate: paid ?? "" } : i));
    await logStatus({ invoiceId: inv.id, projectId: inv.projectId, period: inv.period, from: inv.status, to: nowPaid ? "paid" : "sent", amount: inv.amount });
    setBusy(null);
  };
  /** Unsend: delete the invoice so the work returns to "To bill". */
  const unsend = async (inv: Invoice) => {
    setBusy(`${inv.projectId}|${inv.period}`);
    await supabase.from("invoices").delete().eq("id", inv.id);
    setInvoices((prev) => prev.filter((i) => i.id !== inv.id));
    await logStatus({ invoiceId: inv.id, projectId: inv.projectId, period: inv.period, from: inv.status, to: "tobill", amount: inv.amount });
    setBusy(null);
  };

  /**
   * Move a single entry into another billing period of the SAME project,
   * to smooth billing across months. Persists a per-entry period override.
   * If the target period equals the entry's natural period, the override is cleared.
   */
  const moveEntry = async (entryId: string, toPeriod: string) => {
    const src = entries.find((e) => e.id === entryId);
    if (!src) return;
    const natural = periodForDate(src.date, localCutoffs, defaultCutoffDay);
    const override = toPeriod === natural ? null : toPeriod;
    // optimistic local update
    setLocalMoves((m) => {
      const next = { ...m };
      if (override) next[entryId] = override;
      else delete next[entryId];
      return next;
    });
    await supabase.from("calendar_entries").update({ billing_period: override }).eq("id", entryId);
  };

  // ---- Filter options ----
  const companyOptions = useMemo(() => {
    const seen = new Map<string, string>();
    Object.values(projects).forEach((p) => {
      const name = p.legalName || clientNames[p.clientId] || "—";
      seen.set(p.clientId, name);
    });
    return Array.from(seen, ([value, label]) => ({ value, label }));
  }, [projects, clientNames]);
  const typeOptions = useMemo(() =>
    Object.entries(typeNames).map(([value, label]) => ({ value, label })),
    [typeNames]);

  const matchesFilters = (clientId: string, typeId: string, legal?: string, vat?: string) => {
    if (fCompany && clientId !== fCompany) return false;
    if (fType && typeId !== fType) return false;
    const q = query.trim().toLowerCase();
    if (q) {
      const hay = [legal, clientNames[clientId], vat].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  };

  // ---- Phase lists ----
  const today = isoDate(new Date());
  // Lateness as of the selected month: compare the due date to whichever is
  // earlier — the as-of date, or the day it was actually paid. So an invoice
  // shows the arrears it had accrued *by that month*, growing as you step
  // forward until it's paid.
  const daysLateOf = (inv: Invoice) => {
    if (!inv.dueDate) return 0;
    const ref = wasPaidBy(inv) ? inv.paidDate! : (asOfDate < today ? asOfDate : today);
    if (inv.dueDate >= ref) return 0;
    return Math.round((new Date(`${ref}T00:00:00`).getTime() - new Date(`${inv.dueDate}T00:00:00`).getTime()) / 86400000);
  };

  const outstanding = useMemo(() => {
    // To bill: anything not yet invoiced whose period is the selected month or
    // earlier (older arrears still need billing). Future periods are hidden.
    let list = bills.filter((b) =>
      !billedBy(b.key)
      && b.period <= period
      && matchesFilters(b.clientId, b.typeId, b.legalName, b.vat));
    list = list.sort((a, b) => {
      if (sortKey === "amount_asc") return gross(a) - gross(b);
      if (sortKey === "date_asc") return a.period.localeCompare(b.period);
      if (sortKey === "date_desc") return b.period.localeCompare(a.period);
      return gross(b) - gross(a);
    });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bills, invByKey, sortKey, fCompany, fType, query, period]);

  // End of the selected billing month — the "as of" date for the point-in-time
  // view. An invoice's status is judged as it stood then.
  const invoiceList = (want: "sent" | "paid") => {
    // Point-in-time: PAID = paid on/before the as-of date. SENT = issued by then
    // but not yet paid at that point (whether or not it was paid later). So an
    // invoice paid late shows as Sent (and overdue) in the months it sat unpaid,
    // then moves to Paid once its payment date is reached.
    let list = invoices.filter((i) => {
      if (!wasSentBy(i)) return false;              // not issued yet as of then
      return want === "paid" ? wasPaidBy(i) : !wasPaidBy(i);
    });
    list = list.filter((i) => {
      const p = projects[i.projectId];
      return p ? matchesFilters(p.clientId, p.typeId, p.legalName, p.vat) : true;
    });
    return list.sort((a, b) => {
      if (sortKey === "amount_asc") return a.amount - b.amount;
      if (sortKey === "amount_desc") return b.amount - a.amount;
      if (sortKey === "date_asc") return (a.sentDate || "").localeCompare(b.sentDate || "");
      if (sortKey === "date_desc") return (b.sentDate || "").localeCompare(a.sentDate || "");
      if (sortKey === "expired") return daysLateOf(b) - daysLateOf(a);
      return b.amount - a.amount;
    });
  };
  const sentList = invoiceList("sent");
  const paidList = invoiceList("paid");

  // ---- Excel export of the ticked To-bill rows ----------------------------
  const toggleSel = (key: string) =>
    setSelected((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const allVisibleSelected = outstanding.length > 0 && outstanding.every((b) => selected.has(b.key));
  const toggleSelAll = () =>
    setSelected(() => allVisibleSelected ? new Set() : new Set(outstanding.map((b) => b.key)));

  /**
   * Invoicing sheet, laid out exactly like the finance team's template:
   * row 1 empty, headers from column B, one row per billing line. A bill with
   * both consultancy and supervision work is split into two rows. Every row is
   * labelled in column A ("Senior Consultant" / "Project Manager"). Connector days bill at the consultancy rate, so they join
   * the consultancy row. Amounts are live formulas (price × days) with totals.
   */
  const exportSelected = async () => {
    const chosen = outstanding.filter((b) => selected.has(b.key));
    if (chosen.length === 0) return;
    setExporting(true);
    try {
      const addrParts = (a: any) => {
        if (!a) return { street: "", zip: "", city: "" };
        if (typeof a === "string") return { street: a, zip: "", city: "" };
        const street = [[a.street ?? a.line1 ?? a.address, a.number].filter(Boolean).join(" "), a.details ?? a.line2].filter(Boolean).join(", ");
        return { street, zip: postalOf(a), city: a.city ?? "" };
      };
      const invoiceEmails = (contacts: any[]) => {
        const list = Array.isArray(contacts) ? contacts : [];
        const billing = list.filter((c) => c?.billing && c?.email);
        const pick = billing.length ? billing : list.filter((c) => c?.email).slice(0, 1);
        return pick.map((c) => String(c.email).trim());
      };

      const HEAD = ["Client", "VAT Number", "Adress", "Postal Code", "City", "Invoice email (CC: Basilio always)",
        "Project name", "PRICE", "Invoice Month", "Invoicing days", "Invoice amount"];
      const FIRST = 1, LAST = HEAD.length; // table spans columns B..L
      const PRICE = `"€ "#,##0.00`, MONEY = `#,##0.00 "€"`;

      type Part = { role: string; days: number; rate: number };
      const lines: { b: Bill; part: Part }[] = [];
      chosen.forEach((b) => {
        const parts: Part[] = [];
        const cons = b.lines.consultor + b.lines.connector;
        if (cons > 0) parts.push({ role: "Senior Consultant", days: cons, rate: b.rate });
        if (b.lines.supervision > 0) parts.push({ role: "Project Manager", days: b.lines.supervision, rate: b.supervisionRate });
        parts.forEach((part) => lines.push({ b, part }));
      });

      const firstData = 3, lastData = firstData + lines.length - 1;
      // Outer medium frame around header + data, thin rule under the header.
      const frame = (rowNo: number, col: number, extra: XStyle = {}): XStyle => {
        const border: XStyle["border"] = {};
        if (col === FIRST) border.l = "medium";
        if (col === LAST) border.r = "medium";
        if (rowNo === 2) { border.t = "medium"; border.b = "thin"; }
        if (rowNo === lastData) border.b = "medium";
        return Object.keys(border).length ? { ...extra, border } : extra;
      };

      const rows: (XCell | null)[][] = [[]];
      rows.push([null, ...HEAD.map((h, i) => ({ v: h, s: frame(2, i + 1, { bold: true }) }))]);

      lines.forEach(({ b, part }, i) => {
        const r = firstData + i;
        const p = projects[b.projectId];
        const ad = addrParts(p?.address);
        const emails = invoiceEmails(p?.contacts ?? []);
        const days = +part.days.toFixed(2);
        rows.push([
          { v: part.role },
          { v: b.legalName, s: frame(r, 1, { bold: true }) },
          { v: b.vat || "", s: frame(r, 2) },
          { v: ad.street, s: frame(r, 3) },
          { v: ad.zip, s: frame(r, 4, { align: "right" }) },  // text: keeps leading zeros (08028)
          { v: ad.city, s: frame(r, 5) },
          { v: emails.join(" ; "), link: emails.length ? `mailto:${emails.join(";")}` : undefined,
            s: frame(r, 6, emails.length ? { color: "0563C1", underline: true } : {}) },
          { v: clientNames[b.clientId] || b.legalName, s: frame(r, 7) },
          { v: part.rate, s: frame(r, 8, { fmt: PRICE }) },
          { v: cutoffOf(b.period, localCutoffs, defaultCutoffDay), date: true, s: frame(r, 9, { fmt: "dd-mmm", align: "right" }) },
          { v: days, s: frame(r, 10) },
          { v: +(days * part.rate).toFixed(2), formula: `I${r}*K${r}`, s: frame(r, 11, { fmt: MONEY }) },
        ]);
      });

      // Totals, boxed under the last three columns.
      const tr = lastData + 1;
      const box = (col: number, extra: XStyle = {}): XStyle => ({
        ...extra, border: { t: "medium", b: "medium", ...(col === 9 ? { l: "medium" } : {}), ...(col === LAST ? { r: "medium" } : {}) },
      });
      const totDays = lines.reduce((s, l) => s + +l.part.days.toFixed(2), 0);
      const totAmt = lines.reduce((s, l) => s + +(+l.part.days.toFixed(2) * l.part.rate).toFixed(2), 0);
      const total: (XCell | null)[] = Array(LAST + 1).fill(null);
      total[9] = { v: "Total", s: box(9) };
      total[10] = { v: +totDays.toFixed(2), formula: `SUM(K${firstData}:K${lastData})`, s: box(10, { bold: true }) };
      total[11] = { v: +totAmt.toFixed(2), formula: `SUM(L${firstData}:L${lastData})`, s: box(11, { bold: true, fmt: MONEY }) };
      rows.push(total);

      const blob = sheetToXlsx({
        name: periodLabel(period),
        cols: [18, 54, 14, 50, 12, 13, 52, 14, 12, 15, 15, 16],
        rows,
      });
      const stamp = new Date().toISOString().slice(0, 10);
      downloadBlob(blob, `to-bill_${periodLabel(period).replace(/\s/g, "-")}_${stamp}.xlsx`);
    } finally {
      setExporting(false);
    }
  };

  // ---- Totals ----
  // Header is a GLOBAL snapshot (all periods) — your standing financial
  // position — while the lists below scope to the month picked in the header.
  const outstandingTotal = bills
    .filter((b) => !billedBy(b.key) && b.period <= period)
    .reduce((s, b) => s + gross(b), 0);
  const outstandingCount = bills.filter((b) => !billedBy(b.key) && b.period <= period).length;
  // Header snapshot AS OF the selected month.
  const sentTotal = invoices.filter((i) => wasSentBy(i) && !wasPaidBy(i)).reduce((s, i) => s + i.amount, 0);
  const paidTotal = invoices.filter((i) => wasPaidBy(i)).reduce((s, i) => s + i.amount, 0);
  const overdueCount = invoices.filter((i) => wasSentBy(i) && !wasPaidBy(i) && daysLateOf(i) > 0).length;

  const nextRun = (() => {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const thisMonth = sendDateFor(period);
    const run = thisMonth >= t ? thisMonth : (() => {
      const [y, m] = period.split("-").map(Number);
      const np = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
      return sendDateFor(np);
    })();
    const days = Math.round((run.getTime() - t.getTime()) / 86400000);
    return { date: run, days, iso: isoDate(run) };
  })();

  const projName = (pid: string) => {
    const p = projects[pid];
    return p ? (p.legalName || clientNames[p.clientId] || "—") : "—";
  };

  const billComposition = (b: Bill, frozen?: Invoice) => {
    const owners = responsibleFor(b);
    // A sent/paid invoice is frozen: show exactly what was invoiced (net, tax,
    // total, days), not a live recompute from today's entries. Later changes to
    // the entries roll into the next bill, so we only flag that they differ.
    const liveNet = net(b);
    const liveGross = gross(b);
    const fNet = frozen ? frozen.net : liveNet;
    const fGross = frozen ? frozen.amount : liveGross;
    const fTax = +(fGross - fNet).toFixed(2);
    // Reconstruct the effective tax rate from the frozen figures when possible.
    const fTaxRate = frozen ? (fNet > 0 ? Math.round((fGross / fNet - 1) * 100) : b.taxRate) : b.taxRate;
    const drift = frozen ? Math.abs(liveGross - fGross) > 0.01 : false;
    const ownerMax = Math.max(0.0001, ...owners.map(([, v]) => v.value));
    const u = unitOf(b.projectId);
    return (
      <>
        <div className="bn-dcols">
          <div className="bn-dbox">
            <span className="bn-dh">{frozen ? "How this bill was invoiced" : "How this bill is made up"}</span>
            {frozen && drift ? (
              <div className="bn-bd">
                <span className="bn-bd-name">Invoiced amount</span>
                <span className="bn-bd-calc">{frozen.days.toFixed(2)}{u} invoiced</span>
                <span className="bn-bd-val">{eur(fNet)} €</span>
              </div>
            ) : (
              (["consultor", "supervision", "connector"] as Line[]).map((ln) =>
                b.lines[ln] > 0 ? (
                  <div className={`bn-bd is-${ln}`} key={ln}>
                    <span className="bn-bd-name"><i />{lineLabel[ln]}</span>
                    <span className="bn-bd-calc">
                      {b.lines[ln].toFixed(2)}{u} × {(ln === "supervision" ? b.supervisionRate : b.rate).toLocaleString()} €
                    </span>
                    <span className="bn-bd-val">
                      {eur(b.lines[ln] * (ln === "supervision" ? b.supervisionRate : b.rate))} €
                    </span>
                  </div>
                ) : null
              )
            )}
            <div className="bn-bd is-sub">
              <span className="bn-bd-name">Net</span><span className="bn-bd-calc" />
              <span className="bn-bd-val">{eur(fNet)} €</span>
            </div>
            {(frozen ? fTax > 0.01 : b.taxed) && (
              <div className="bn-bd">
                <span className="bn-bd-name">Tax</span><span className="bn-bd-calc">{fTaxRate}%</span>
                <span className="bn-bd-val">{eur(fTax)} €</span>
              </div>
            )}
            <div className="bn-bd is-total">
              <span className="bn-bd-name">Total</span><span className="bn-bd-calc" />
              <span className="bn-bd-val">{eur(fGross)} €</span>
            </div>
            {frozen && (
              <p className={`bn-frozen ${drift ? "is-drift" : ""}`}>
                {drift
                  ? `Invoiced ${eur(fGross)} € for ${frozen.days.toFixed(2)}${u} on ${bnDate(frozen.sentDate)}. Entries have changed since; the difference rolls into the next bill.`
                  : `Invoiced as sent on ${bnDate(frozen.sentDate)}.`}
              </p>
            )}
          </div>
          <div className="bn-dbox">
            <span className="bn-dh">Who's responsible</span>
            {owners.map(([uid, v], oi) => (
              <div className="bn-owner" key={uid} style={bnVars({ "--d": oi })}>
                <span className="bn-av is-sm">{(people[uid] ?? "?").charAt(0).toUpperCase()}</span>
                <span className="bn-oname">{people[uid] ?? "Unknown"}</span>
                <span className="bn-odays">{v.days.toFixed(2)}{u}</span>
                <span className="bn-oval">{eur(v.value)} €</span>
                <span className="bn-obar" aria-hidden="true"><i style={{ width: `${(v.value / ownerMax) * 100}%` }} /></span>
              </div>
            ))}
          </div>
        </div>
        <span className="bn-dh bn-ledger-h">
          {frozen ? "Entries recorded for this period" : "Entries feeding this bill"}
          {phase === "tobill" && <em>Drag an entry onto another month of this client to move its billing</em>}
        </span>
        <div className="bn-ledger">
          <div className="bn-lhead">
            <span>Date</span><span>Consultant</span><span>Line</span><span>Status</span>
            <span className="bn-r">{u === "h" ? "Hours" : "Days"}</span><span className="bn-r">Value</span>
          </div>
          {b.rows.map((r, li) => (
            <div
              className={`bn-lrow ${r.moved ? "is-moved" : ""} ${dragEntry?.id === r.id ? "is-dragging" : ""} ${phase === "tobill" ? "is-draggable" : ""}`}
              key={r.id}
              style={bnVars({ "--d": Math.min(li, 12) })}
              draggable={phase === "tobill"}
              onDragStart={(e) => {
                setDragEntry({ id: r.id, projectId: b.projectId, fromPeriod: b.period });
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => { setDragEntry(null); setDropTarget(null); }}
              title={phase === "tobill" ? "Drag to another period of this client to move billing" : undefined}
            >
              <span className="bn-ldate">
                {phase === "tobill" && <span className="bn-grip"><BnIcon d={BN_ICON.grip} w={3} /></span>}
                {bnDate(r.date)}{r.moved && <span className="bn-moved">moved</span>}
              </span>
              <span className="bn-lwho">{people[r.userId] ?? "Unknown"}</span>
              <span className={`bn-lline is-${r.line}`}>{lineLabel[r.line]}</span>
              <span className={`bn-lstatus is-${r.status}`}>{r.status}</span>
              <span className="bn-r bn-lnum">{r.days.toFixed(2)}{u}</span>
              <span className="bn-r bn-lnum">
                {eur(r.days * (r.line === "supervision" ? b.supervisionRate : b.rate))} €
              </span>
            </div>
          ))}
        </div>
      </>
    );
  };

  const sortOptions = [
    { value: "amount_desc", label: "Amount ↓" },
    { value: "amount_asc", label: "Amount ↑" },
    { value: "date_desc", label: "Newest" },
    { value: "date_asc", label: "Oldest" },
    ...(phase !== "tobill" ? [{ value: "expired", label: "Most overdue" }] : []),
  ];

  const anyFilter = !!(fCompany || fType);

  /* ---------- presentation ---------- */
  const armed = useBnArmed(320);
  const collectedBase = paidTotal + sentTotal;
  const collectedPct = collectedBase > 0 ? (paidTotal / collectedBase) * 100 : 0;
  const awaitingCount = invoices.filter((i) => i.status !== "paid").length;
  const paidCount = invoices.filter((i) => i.status === "paid").length;
  const switchPhase = (p: Phase) => {
    setPhase(p);
    if (p !== "tobill") { setSelectMode(false); setSelected(new Set()); }
  };
  const cutoffInDays = nextRun.days;

  return (
    <div className="bn" onPointerMove={bnSpot}>
      {/* ---------- headline cards on the dark band ---------- */}
      <section className="bn-hero">
        <div className="bn-kpis">
          <div className="bn-kpi is-main" data-spot="tilt" style={bnVars({ "--i": 0 })}>
            <span className="bn-kpi-head">
              <span className="bn-kpi-ico"><BnIcon d={BN_ICON.out} /></span>
              <span className="bn-kpi-label">Outstanding to {periodLabel(period)}</span>
              {alerts.length > 0 && (
                <button type="button" className="bn-alert-chip" onClick={() => setShowAlerts(true)}
                  title={`${alerts.length} attempt${alerts.length === 1 ? "" : "s"} to log work in a closed period`}>
                  <BnIcon d={BN_ICON.warn} w={2.2} />
                  {alerts.length}
                </button>
              )}
            </span>
            <b className="bn-val is-xl"><BnCount value={outstandingTotal} fmt={eur} /><em>€</em></b>
            <small className="bn-kpi-sub">{outstandingCount} {outstandingCount === 1 ? "invoice" : "invoices"} ready to send</small>
          </div>

          <div className="bn-kpi is-collected" data-spot="tilt" style={bnVars({ "--i": 1 })}>
            <span className="bn-kpi-head">
              <span className="bn-kpi-ico"><BnIcon d={BN_ICON.paid} w={2.4} /></span>
              <span className="bn-kpi-label">Collected</span>
            </span>
            <span className="bn-coll">
              <span className="bn-dial" aria-hidden="true">
                <svg viewBox="0 0 140 80">
                  <path className="bn-arc-bg" d={BN_ARC} pathLength={100} />
                  <path className={`bn-arc-fill ${armed && collectedPct > 0 ? "" : "is-zero"}`} d={BN_ARC} pathLength={100}
                    style={{ strokeDasharray: `${armed ? Math.min(100, collectedPct).toFixed(2) : 0} 101` }} />
                </svg>
                <span className="bn-dial-pct"><BnCount value={collectedPct} /><em>%</em></span>
              </span>
              <span className="bn-coll-txt">
                <b className="bn-val"><BnCount value={paidTotal} fmt={eur} /><em>€</em></b>
                <small className="bn-kpi-sub">{paidCount} paid</small>
              </span>
            </span>
          </div>

          <div className="bn-kpi" data-spot="tilt" style={bnVars({ "--i": 2 })}>
            <span className="bn-kpi-head">
              <span className="bn-kpi-ico"><BnIcon d={BN_ICON.sent} /></span>
              <span className="bn-kpi-label">Awaiting payment</span>
            </span>
            <b className="bn-val"><BnCount value={sentTotal} fmt={eur} /><em>€</em></b>
            <small className="bn-kpi-sub">{awaitingCount} awaiting</small>
          </div>

          <div className={`bn-kpi ${overdueCount ? "is-bad" : ""}`} data-spot="tilt" style={bnVars({ "--i": 3 })}>
            <span className="bn-kpi-head">
              <span className="bn-kpi-ico"><BnIcon d={BN_ICON.late} /></span>
              <span className="bn-kpi-label">Overdue</span>
            </span>
            <b className="bn-val"><BnCount value={overdueCount} /></b>
            <small className="bn-kpi-sub">{overdueCount === 1 ? "invoice" : "invoices"} past due</small>
          </div>

          <div className={`bn-kpi is-cutoff ${cutoffOpen ? "is-editing" : ""}`} data-spot="tilt" style={bnVars({ "--i": 4 })}>
            <span className="bn-kpi-head">
              <span className="bn-kpi-ico"><BnIcon d={BN_ICON.cal} /></span>
              <span className="bn-kpi-label">Next billing cutoff</span>
            </span>
            <button type="button" className="bn-cutoff" onClick={() => setCutoffOpen((v) => !v)} title="Change this month's cutoff">
              {nextRun.date.toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" })}
              <BnIcon d={BN_ICON.edit} w={2} />
            </button>
            <small className="bn-kpi-sub">
              {cutoffInDays === 0 ? "Today" : cutoffInDays === 1 ? "Tomorrow" : cutoffInDays > 1 ? `In ${cutoffInDays} days` : `${Math.abs(cutoffInDays)} days ago`}
            </small>
            {cutoffOpen && (
              <div className="bn-cutoff-pop">
                <span>Cutoff for {periodLabel(period)}</span>
                <DatePicker value={cutoffOf(period, localCutoffs, defaultCutoffDay)} onChange={saveCutoff} />
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ---------- light sheet ---------- */}
      <section className="bn-sheet">
        <div className="bn-controls">
          <div className="bn-phases" data-phase={phase} role="tablist" aria-label="Invoices">
            <span className="bn-phases-pill" aria-hidden="true" />
            <button type="button" role="tab" aria-selected={phase === "tobill"} className={phase === "tobill" ? "is-on" : ""} onClick={() => switchPhase("tobill")}>
              To bill <i>{outstanding.length}</i>
            </button>
            <button type="button" role="tab" aria-selected={phase === "sent"} className={phase === "sent" ? "is-on" : ""} onClick={() => switchPhase("sent")}>
              Sent <i>{sentList.length}</i>
            </button>
            <button type="button" role="tab" aria-selected={phase === "paid"} className={phase === "paid" ? "is-on" : ""} onClick={() => switchPhase("paid")}>
              Paid <i>{paidList.length}</i>
            </button>
            <button type="button" role="tab" aria-selected={phase === "history"} className={phase === "history" ? "is-on" : ""} onClick={() => switchPhase("history")}>
              History
            </button>
          </div>

          <div className="bn-filters">
            {phase === "tobill" && (
              <div className="bn-status" data-status={status} role="radiogroup" aria-label="Which work to bill">
                <span className="bn-status-pill" aria-hidden="true" />
                <button type="button" role="radio" aria-checked={status === "billed"} className={status === "billed" ? "is-on" : ""} onClick={() => setStatus("billed")}>Delivered</button>
                <button type="button" role="radio" aria-checked={status === "scheduled"} className={status === "scheduled" ? "is-on" : ""} onClick={() => setStatus("scheduled")}>Scheduled</button>
                <button type="button" role="radio" aria-checked={status === "all"} className={status === "all" ? "is-on" : ""} onClick={() => setStatus("all")}>Both</button>
              </div>
            )}
            <div className="bn-search">
              <span className="bn-search-ico"><BnIcon d={BN_ICON.search} w={2.1} /></span>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search client, VAT…" />
              {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear">×</button>}
            </div>
            <div className="bn-sel is-sort">
              <Select value={sortKey} onChange={(v) => setSortKey(v as SortKey)} options={sortOptions} />
            </div>
            <div className="bn-sel">
              <Select value={fCompany} onChange={setFCompany}
                options={[{ value: "", label: "All companies" }, ...companyOptions]} placeholder="Company" />
            </div>
            <div className="bn-sel">
              <Select value={fType} onChange={setFType}
                options={[{ value: "", label: "All types" }, ...typeOptions]} placeholder="Type" />
            </div>
            {phase === "tobill" && (
              selectMode ? (
                <div className="bn-xlsx-group">
                  <button type="button" className="bn-xlsx is-go" disabled={selected.size === 0 || exporting} onClick={exportSelected}
                    title={selected.size === 0 ? "Tick rows to export" : `Download ${selected.size} selected`}>
                    <BnIcon d={BN_ICON.xls} w={1.9} />
                    {exporting ? "…" : `Download${selected.size ? ` (${selected.size})` : ""}`}
                  </button>
                  <button type="button" className="bn-xlsx-cancel" onClick={() => { setSelectMode(false); setSelected(new Set()); }}>Cancel</button>
                </div>
              ) : (
                <button type="button" className="bn-xlsx" onClick={() => setSelectMode(true)} title="Select rows to export to Excel">
                  <BnIcon d={BN_ICON.xls} w={1.9} />
                  Excel
                </button>
              )
            )}
            {(anyFilter || query) && (
              <button type="button" className="bn-clear" onClick={() => { setFCompany(""); setFType(""); setQuery(""); }}>Clear</button>
            )}
          </div>
        </div>

        {/* ---------- lists ---------- */}
        {!loaded ? (
          <div className="bn-empty"><span className="bn-empty-art is-busy"><BnIcon d={BN_ICON.out} w={1.6} /></span><p>Loading invoices…</p></div>
        ) : phase === "tobill" ? (
          outstanding.length === 0 ? (
            <div className="bn-empty"><span className="bn-empty-art"><BnIcon d={BN_ICON.paid} w={1.6} /></span><p>Nothing to bill for these filters.</p></div>
          ) : (
            <div className={`bn-list ${selectMode ? "is-selecting" : ""}`}>
              <div className="bn-head bn-grid-bill">
                {selectMode && (
                  <label className="bn-check is-head" title="Select all">
                    <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelAll} />
                    <span aria-hidden="true" />
                  </label>
                )}
                <span>Bill to</span><span>VAT</span><span>Billing contact</span>
                <span className="bn-r">{"Days"}</span><span className="bn-r">Amount</span><span />
              </div>
              {outstanding.map((b, bi) => {
                const isOpen = open === b.key;
                const totalDays = b.lines.consultor + b.lines.supervision + b.lines.connector;
                const canDrop = !!dragEntry && dragEntry.projectId === b.projectId && dragEntry.fromPeriod !== b.period;
                const isDropHover = canDrop && dropTarget === b.key;
                return (
                  <div
                    className={`bn-row ${selected.has(b.key) ? "is-selected" : ""} ${isOpen ? "is-open" : ""} ${canDrop ? "is-droppable" : ""} ${isDropHover ? "is-drophover" : ""}`}
                    key={b.key}
                    style={bnVars({ "--i": Math.min(bi, 14) })}
                    onDragOver={(e) => { if (canDrop) { e.preventDefault(); setDropTarget(b.key); } }}
                    onDragLeave={() => setDropTarget((t) => (t === b.key ? null : t))}
                    onDrop={(e) => {
                      if (!canDrop || !dragEntry) return;
                      e.preventDefault();
                      moveEntry(dragEntry.id, b.period);
                      setDragEntry(null);
                      setDropTarget(null);
                    }}
                  >
                    {selectMode && (
                      <label className="bn-check" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={selected.has(b.key)} onChange={() => toggleSel(b.key)} />
                        <span aria-hidden="true" />
                      </label>
                    )}
                    <button type="button" className="bn-row-main bn-grid-bill" data-spot="" onClick={() => setOpen(isOpen ? null : b.key)} aria-expanded={isOpen}>
                      <span className="bn-who">
                        <span className="bn-av">{(b.legalName || "?").charAt(0).toUpperCase()}</span>
                        <span className="bn-who-t">
                          <span className="bn-name">
                            <b>{b.legalName}</b>
                            <span className="bn-ptag">{periodLabel(b.period)}</span>
                            {canDrop && <span className="bn-drop-hint">Drop to bill here</span>}
                          </span>
                          <span className="bn-meta">
                            {clientNames[b.clientId] && <span>{clientNames[b.clientId]}</span>}
                            <span>{b.type}</span>
                            {b.address && <span className="bn-addr">{b.address}</span>}
                          </span>
                        </span>
                      </span>
                      <span className="bn-vat">{b.vat || "—"}</span>
                      <span className="bn-contact">
                        {b.contact?.email ? (<><b>{b.contact.email}</b><small>{b.contact.name}</small></>) : <small>No billing contact</small>}
                      </span>
                      <span className="bn-num"><b>{totalDays.toFixed(2)}<em>{unitOf(b.projectId)}</em></b></span>
                      <span className="bn-num is-amt"><b>{eur(gross(b))} €</b></span>
                      <span className="bn-chev"><BnIcon d={BN_ICON.chev} w={2.4} /></span>
                    </button>
                    {isOpen && (
                      <div className="bn-detail">
                        {billComposition(b)}
                        <div className="bn-dactions">
                          <span>Marking as sent records this invoice for {periodLabel(b.period)} and moves it to Sent.</span>
                          <button type="button" className="bn-send" disabled={busy === b.key} onClick={() => markSent(b)}>
                            {busy === b.key ? "Saving…" : <>Mark as sent <BnIcon d={BN_ICON.sent} w={2.2} /></>}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )
        ) : phase === "history" ? (
          statusLog.length === 0 ? (
            <div className="bn-empty"><span className="bn-empty-art"><BnIcon d={BN_ICON.late} w={1.6} /></span><p>No status changes recorded yet. Sending, paying or un-sending an invoice will show up here.</p></div>
          ) : (
            <div className="bn-hist">
              {statusLog.map((r, hi) => {
                const label: Record<string, string> = { tobill: "To bill", sent: "Sent", paid: "Paid" };
                const tone = r.to_status === "paid" ? "paid" : r.to_status === "sent" ? "sent" : "tobill";
                return (
                  <div className={`bn-hist-row tone-${tone}`} key={r.id} style={bnVars({ "--i": Math.min(hi, 14) })}>
                    <span className="bn-hist-dot" aria-hidden="true"><BnIcon d={tone === "paid" ? BN_ICON.paid : tone === "sent" ? BN_ICON.sent : BN_ICON.out} w={2.4} /></span>
                    <div className="bn-hist-main">
                      <span className="bn-hist-title">
                        <b>{r.project_id ? projName(r.project_id) : "Unknown client"}</b>
                        <span className="bn-ptag">{periodLabel(r.period)}</span>
                      </span>
                      <span className="bn-hist-change">
                        {r.from_status ? (label[r.from_status] ?? r.from_status) : "—"}
                        <BnIcon d={BN_ICON.chev} w={2.4} />
                        <b>{label[r.to_status] ?? r.to_status}</b>
                        {r.amount != null && <span className="bn-hist-amt">{eur(r.amount)} €</span>}
                      </span>
                    </div>
                    <span className="bn-hist-meta">
                      <b>{r.changed_by ? (people[r.changed_by] ?? "someone") : "someone"}</b>
                      {new Date(r.created_at).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                );
              })}
            </div>
          )
        ) : (
          (() => {
            const list = phase === "sent" ? sentList : paidList;
            if (list.length === 0) {
              return (
                <div className="bn-empty">
                  <span className="bn-empty-art"><BnIcon d={phase === "sent" ? BN_ICON.sent : BN_ICON.paid} w={1.6} /></span>
                  <p>No {phase === "sent" ? "sent" : "paid"} invoices for these filters.</p>
                </div>
              );
            }
            const mismatchCount = list.filter((inv) => {
              const comp = billByKey[`${inv.projectId}|${inv.period}`];
              return comp && Math.abs(+gross(comp).toFixed(2) - inv.amount) > 0.01;
            }).length;
            return (
              <div className="bn-list">
                {mismatchCount > 0 && (
                  <div className="bn-fixbar">
                    <span className="bn-fixbar-ico"><BnIcon d={BN_ICON.warn} w={1.9} /></span>
                    <span>{mismatchCount} invoice{mismatchCount === 1 ? "" : "s"} no longer match their entries.</span>
                    <button type="button" className="bn-fixall" onClick={() => recomputeMany(list)}>Fix all {mismatchCount}</button>
                  </div>
                )}
                <div className="bn-head bn-grid-inv">
                  <span>Client</span><span>Sent</span><span>Due</span>
                  <span className="bn-r">Amount</span><span>Status</span><span />
                </div>
                {list.map((inv, ii) => {
                  // Status AS OF the selected month: an invoice paid later still
                  // reads as Sent/Overdue in the months before its payment.
                  const paidAsOf = wasPaidBy(inv);
                  const late = daysLateOf(inv);
                  const isOverdue = !paidAsOf && late > 0;
                  const invKey = `${inv.projectId}|${inv.period}`;
                  const comp = billByKey[invKey];
                  const isOpen = open === invKey;
                  // Does the frozen invoice still match what the entries sum to?
                  const liveDays = comp ? +(comp.lines.consultor + comp.lines.supervision + comp.lines.connector).toFixed(2) : inv.days;
                  const liveAmount = comp ? +gross(comp).toFixed(2) : inv.amount;
                  const mismatch = comp ? Math.abs(liveAmount - inv.amount) > 0.01 : false;
                  const u = unitOf(inv.projectId);
                  const tone = paidAsOf ? "paid" : isOverdue ? "overdue" : "sent";
                  const toggle = () => comp && setOpen(isOpen ? null : invKey);
                  return (
                    <div className={`bn-row bn-inv tone-${tone} ${isOpen ? "is-open" : ""}`} key={inv.id} style={bnVars({ "--i": Math.min(ii, 14) })}>
                      <div
                        className={`bn-row-main bn-grid-inv ${comp ? "is-clickable" : ""}`}
                        data-spot=""
                        role={comp ? "button" : undefined}
                        tabIndex={comp ? 0 : -1}
                        aria-expanded={comp ? isOpen : undefined}
                        onClick={toggle}
                        onKeyDown={(e) => { if (comp && (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); toggle(); } }}
                      >
                        <span className="bn-who">
                          <span className="bn-av">{projName(inv.projectId).charAt(0).toUpperCase()}</span>
                          <span className="bn-who-t">
                            <span className="bn-name"><b>{projName(inv.projectId)}</b></span>
                            <span className="bn-meta">
                              <span className="bn-ptag">{periodLabel(inv.period)}</span>
                              <span>{inv.days.toFixed(2)}{u}</span>
                            </span>
                          </span>
                        </span>

                        <span className="bn-when"><small>Sent</small><b>{bnDate(inv.sentDate)}</b></span>
                        <span className={`bn-when ${isOverdue ? "is-overdue" : ""}`}>
                          <small>Due</small>
                          <b>{bnDate(inv.dueDate)}</b>
                          {isOverdue && <span className="bn-late">{late}d late</span>}
                        </span>

                        <span className="bn-num is-amt">
                          <b>{eur(inv.amount)} €</b>
                          {mismatch && (
                            <span className="bn-mismatch" title={`Entries now sum to ${liveDays.toFixed(2)}${u} / ${eur(liveAmount)} €`}>
                              Entries: {eur(liveAmount)} €
                            </span>
                          )}
                        </span>

                        <span className={`bn-badge tone-${tone}`}>
                          <i />
                          <span>
                            {paidAsOf ? "Paid" : isOverdue ? "Overdue" : "Awaiting"}
                            {paidAsOf && inv.paidDate && <small>{bnDate(inv.paidDate)}</small>}
                          </span>
                        </span>

                        <span className="bn-actions">
                          {phase === "sent" && (
                            <button type="button" className="bn-act is-ghost" disabled={busy === invKey}
                              onClick={(e) => { e.stopPropagation(); unsend(inv); }} title="Move back to To bill">
                              Unsend
                            </button>
                          )}
                          {mismatch && comp && (
                            <button type="button" className="bn-act is-warn" disabled={busy === invKey}
                              onClick={(e) => { e.stopPropagation(); openFix(inv, comp); }}
                              title="Adjust this invoice's days and amount">
                              Fix
                            </button>
                          )}
                          <button type="button" className={`bn-act ${inv.status === "paid" ? "is-ghost" : "is-pay"}`}
                            disabled={busy === invKey} onClick={(e) => { e.stopPropagation(); togglePaid(inv); }}>
                            {inv.status === "paid" ? "Undo" : "Mark paid"}
                          </button>
                          {comp && <span className="bn-chev"><BnIcon d={BN_ICON.chev} w={2.4} /></span>}
                        </span>
                      </div>
                      {isOpen && comp && <div className="bn-detail">{billComposition(comp, inv)}</div>}
                    </div>
                  );
                })}
              </div>
            );
          })()
        )}
      </section>

      {/* ---------- late-log alerts ---------- */}
      {showAlerts && (
        <div className="bn-pop-backdrop" onMouseDown={() => setShowAlerts(false)}>
          <div className="bn-pop" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Late-log attempts">
            <header className="bn-pop-head">
              <span className="bn-pop-ico is-warn"><BnIcon d={BN_ICON.warn} w={2} /></span>
              <div>
                <h3>Late-log attempts</h3>
                <small>Work someone tried to log in a period that was already closed</small>
              </div>
              <button type="button" className="bn-pop-x" onClick={() => setShowAlerts(false)} aria-label="Close"><BnIcon d={BN_ICON.x} w={2.2} /></button>
            </header>
            {alerts.length === 0 ? (
              <p className="bn-pop-empty">Nothing pending. Attempts to log work in a closed period show up here.</p>
            ) : (
              <>
                <div className="bn-pop-list">
                  {alerts.map((a, ai) => (
                    <div className="bn-alert" key={a.id} style={bnVars({ "--d": Math.min(ai, 10) })}>
                      <div className="bn-alert-main">
                        <b>{a.project_id ? projName(a.project_id) : "Unknown client"}</b>
                        <span>
                          {a.billable.toFixed(2)}{a.project_id ? unitOf(a.project_id) : "d"} {a.billing_line ?? "consultor"}, dated {bnDate(a.entry_date)}, would fall in {periodLabel(a.period)}
                        </span>
                        <small>
                          by {a.attempted_by ? (people[a.attempted_by] ?? "someone") : "someone"} on {new Date(a.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                        </small>
                      </div>
                      <button type="button" className="bn-alert-x" onClick={() => dismissAlert(a.id)} title="Dismiss"><BnIcon d={BN_ICON.x} w={2.2} /></button>
                    </div>
                  ))}
                </div>
                <footer className="bn-pop-foot">
                  <button type="button" className="bn-act is-ghost" onClick={dismissAllAlerts}>Dismiss all</button>
                </footer>
              </>
            )}
          </div>
        </div>
      )}

      {/* ---------- fix an invoice ---------- */}
      {fixing && (() => {
        const b = fixing.bill;
        const u = unitOf(b.projectId);
        const rateOf = (line: Line) => line === "supervision" ? b.supervisionRate : b.rate;
        const lineLabels: Record<Line, string> = { consultor: "Consultancy", supervision: "Supervision", connector: "Connector", closure: "Closure" } as Record<Line, string>;

        const num = (v: string) => (v === "" || isNaN(Number(v)) ? 0 : Number(v));
        const invalid = fixing.cells.some((c) => c.days !== "" && isNaN(Number(c.days)));

        // Totals per line and grand totals.
        const lineTotal = (line: Line) => fixing.cells.filter((c) => c.line === line).reduce((s2, c) => s2 + num(c.days), 0);
        const consultor = lineTotal("consultor");
        const supervision = lineTotal("supervision");
        const connector = lineTotal("connector");
        const newNet = consultor * b.rate + connector * b.rate + supervision * b.supervisionRate;
        const newAmount = newNet * (b.taxed ? 1 + b.taxRate / 100 : 1);
        const newDays = +(consultor + supervision + connector).toFixed(2);

        // Group cells by line, preserving order, for rendering.
        const lines: Line[] = ["consultor", "supervision", "connector"];
        const setCell = (i: number, v: string) =>
          setFixing((f) => f && { ...f, cells: f.cells.map((c, j) => j === i ? { ...c, days: v } : c) });

        return (
          <div className="bn-pop-backdrop" onMouseDown={() => setFixing(null)}>
            <div className="bn-pop is-fix" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Adjust invoice">
              <header className="bn-pop-head">
                <span className="bn-pop-ico"><BnIcon d={BN_ICON.edit} w={2} /></span>
                <div>
                  <h3>Adjust invoice, {projName(fixing.inv.projectId)}</h3>
                  <small>
                    {periodLabel(fixing.inv.period)}, currently <b>{fixing.inv.days.toFixed(2)}{u}</b> for {eur(fixing.inv.amount)} €
                    {fixing.inv.status === "paid" && <span className="bn-fix-paid">Marked paid</span>}
                  </small>
                </div>
                <button type="button" className="bn-pop-x" onClick={() => setFixing(null)} aria-label="Close"><BnIcon d={BN_ICON.x} w={2.2} /></button>
              </header>

              <div className="bn-fix-groups">
                {lines.map((line) => {
                  const idxs = fixing.cells.map((c, i) => ({ c, i })).filter((x) => x.c.line === line);
                  if (idxs.length === 0) return null;
                  return (
                    <div className={`bn-fix-group is-${line}`} key={line}>
                      <div className="bn-fix-ghead">
                        <span><i />{lineLabels[line]}</span>
                        <span className="bn-fix-grate">{rateOf(line).toLocaleString()} €/{u}</span>
                        <b>{(+lineTotal(line).toFixed(2))}{u}</b>
                      </div>
                      {idxs.map(({ c, i }) => (
                        <label className="bn-fix-prow" key={i}>
                          <span className="bn-av is-sm">{(people[c.userId] ?? "?").charAt(0).toUpperCase()}</span>
                          <span className="bn-fix-pname">{people[c.userId] ?? "Unknown"}</span>
                          <input type="number" step="0.25" min="0" value={c.days}
                            onChange={(e) => setCell(i, e.target.value)} />
                          <span className="bn-fix-u">{u}</span>
                        </label>
                      ))}
                    </div>
                  );
                })}
              </div>

              <button type="button" className="bn-fix-reset"
                onClick={() => setFixing((f) => f && { ...f, cells: cellsFromBill(f.bill) })}>
                Reset to entries ({(+(b.lines.consultor + b.lines.supervision + b.lines.connector).toFixed(2))}{u})
              </button>

              <div className="bn-fix-preview">
                <div><span>Days</span><b>{newDays}{u}</b></div>
                <div><span>Net</span><b>{eur(newNet)} €</b></div>
                {b.taxed && <div><span>Tax {b.taxRate}%</span><b>{eur(newNet * b.taxRate / 100)} €</b></div>}
                <div className="is-total"><span>Total</span><b>{eur(newAmount)} €</b></div>
              </div>

              <footer className="bn-pop-foot">
                <button type="button" className="bn-act is-ghost" onClick={() => setFixing(null)}>Cancel</button>
                <button type="button" className="bn-act is-pay" disabled={invalid || busy === `${fixing.inv.projectId}|${fixing.inv.period}`}
                  onClick={async () => {
                    await recomputeInvoice(fixing.inv, b, { consultor, supervision, connector });
                    setFixing(null);
                  }}>
                  Save invoice
                </button>
              </footer>
            </div>
          </div>
        );
      })()}
    </div>
  );
}