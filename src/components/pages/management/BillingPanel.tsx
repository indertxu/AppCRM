/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useState, useEffect } from "react";
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
type Phase = "tobill" | "sent" | "paid";
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
    }
    setBusy(null);
  };
  const togglePaid = async (inv: Invoice) => {
    setBusy(`${inv.projectId}|${inv.period}`);
    const nowPaid = inv.status !== "paid";
    const paid = nowPaid ? isoDate(new Date()) : null;
    await supabase.from("invoices").update({ status: nowPaid ? "paid" : "sent", paid_date: paid }).eq("id", inv.id);
    setInvoices((prev) => prev.map((i) => i.id === inv.id ? { ...i, status: nowPaid ? "paid" : "sent", paidDate: paid ?? "" } : i));
    setBusy(null);
  };
  /** Unsend: delete the invoice so the work returns to "To bill". */
  const unsend = async (inv: Invoice) => {
    setBusy(`${inv.projectId}|${inv.period}`);
    await supabase.from("invoices").delete().eq("id", inv.id);
    setInvoices((prev) => prev.filter((i) => i.id !== inv.id));
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

  const billComposition = (b: Bill) => {
    const owners = responsibleFor(b);
    return (
      <>
        <div className="bi-detail-cols">
          <div className="bi-breakdown">
            <span className="bi-detail-h">How this bill is made up</span>
            {(["consultor", "supervision", "connector"] as Line[]).map((ln) =>
              b.lines[ln] > 0 ? (
                <div className="bi-bd-line" key={ln}>
                  <span className="bi-bd-name">{lineLabel[ln]}</span>
                  <span className="bi-bd-calc">
                    {b.lines[ln].toFixed(2)}{unitOf(b.projectId)} × {(ln === "supervision" ? b.supervisionRate : b.rate).toLocaleString()} €
                  </span>
                  <span className="bi-bd-val">
                    {eur(b.lines[ln] * (ln === "supervision" ? b.supervisionRate : b.rate))} €
                  </span>
                </div>
              ) : null
            )}
            <div className="bi-bd-line bi-bd-sub">
              <span className="bi-bd-name">Net</span><span className="bi-bd-calc" />
              <span className="bi-bd-val">{eur(net(b))} €</span>
            </div>
            {b.taxed && (
              <div className="bi-bd-line">
                <span className="bi-bd-name">Tax</span><span className="bi-bd-calc">{b.taxRate}%</span>
                <span className="bi-bd-val">{eur(net(b) * b.taxRate / 100)} €</span>
              </div>
            )}
            <div className="bi-bd-line bi-bd-total">
              <span className="bi-bd-name">Total</span><span className="bi-bd-calc" />
              <span className="bi-bd-val">{eur(gross(b))} €</span>
            </div>
          </div>
          <div className="bi-owners">
            <span className="bi-detail-h">Who's responsible</span>
            {owners.map(([uid, v]) => (
              <div className="bi-owner" key={uid}>
                <span className="bi-oav">{(people[uid] ?? "?").charAt(0).toUpperCase()}</span>
                <span className="bi-oname">{people[uid] ?? "Unknown"}</span>
                <span className="bi-odays">{v.days.toFixed(2)}{unitOf(b.projectId)}</span>
                <span className="bi-oval">{eur(v.value)} €</span>
              </div>
            ))}
          </div>
        </div>
        <span className="bi-detail-h bi-ledger-h">Entries feeding this bill</span>
        <div className="bi-ledger">
          <div className="bi-lhead">
            <span>Date</span><span>Consultant</span><span>Line</span><span>Status</span>
            <span className="bi-r">Days</span><span className="bi-r">Value</span>
          </div>
          {b.rows.map((r) => (
            <div
              className={`bi-lrow ${r.moved ? "is-moved" : ""} ${dragEntry?.id === r.id ? "is-dragging" : ""}`}
              key={r.id}
              draggable={phase === "tobill"}
              onDragStart={(e) => {
                setDragEntry({ id: r.id, projectId: b.projectId, fromPeriod: b.period });
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => { setDragEntry(null); setDropTarget(null); }}
              title={phase === "tobill" ? "Drag to another period of this client to move billing" : undefined}
            >
              <span className="bi-ldate">
                {phase === "tobill" && <span className="bi-drag-handle">⠿</span>}
                {r.date || "—"}{r.moved && <span className="bi-moved-tag">moved</span>}
              </span>
              <span>{people[r.userId] ?? "Unknown"}</span>
              <span className="bi-lline">{lineLabel[r.line]}</span>
              <span className={`bi-lstatus is-${r.status}`}>{r.status}</span>
              <span className="bi-r">{r.days.toFixed(2)}{unitOf(b.projectId)}</span>
              <span className="bi-r">
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

  return (
    <div className="bi">
      {/* ---------- Fixed hero ---------- */}
      <div className="bi-hero bi-hero-neon">
        <span className="bi-hero-glow" aria-hidden="true" />
        <span className="bi-hero-scan" aria-hidden="true" />

        <div className="bi-hero-main">
          <span className="bi-hero-label">Outstanding · to {periodLabel(period)}</span>
          <span className="bi-hero-amount"><b>{eur(outstandingTotal)}</b><i>€</i></span>
          <span className="bi-hero-sub">{outstandingCount} {outstandingCount === 1 ? "invoice" : "invoices"} ready to send</span>
        </div>

        {(() => {
          const total = paidTotal + sentTotal;
          const pct = total > 0 ? (paidTotal / total) * 100 : 0;
          const ARC = 169.65;
          return (
            <div className="bi-hero-ring">
              <svg viewBox="0 0 140 82" aria-hidden="true">
                <path className="bi-arc-bg" d="M16 70 A54 54 0 0 1 124 70" pathLength={ARC} />
                <path className="bi-arc-fill" d="M16 70 A54 54 0 0 1 124 70" pathLength={ARC}
                  style={{ strokeDasharray: `${(ARC * Math.min(1, pct / 100)).toFixed(2)} ${ARC}` }} />
              </svg>
              <span className="bi-ring-mid"><b>{Math.round(pct)}</b><i>% collected</i></span>
            </div>
          );
        })()}

        <div className="bi-hero-stats">
          <div className="bi-stat">
            <span className="bi-stat-k">Sent</span>
            <span className="bi-stat-v">{eur(sentTotal)}<em>€</em></span>
            <span className="bi-stat-s">{invoices.filter((i) => i.status !== "paid").length} awaiting</span>
          </div>
          <div className="bi-stat">
            <span className="bi-stat-k">Collected</span>
            <span className="bi-stat-v is-neon">{eur(paidTotal)}<em>€</em></span>
            <span className="bi-stat-s">{invoices.filter((i) => i.status === "paid").length} paid</span>
          </div>
          <div className="bi-stat">
            <span className="bi-stat-k">Overdue</span>
            <span className={`bi-stat-v ${overdueCount ? "is-bad" : ""}`}>{overdueCount}</span>
            <span className="bi-stat-s">past due</span>
          </div>
        </div>

        <div className="bi-hero-cutoff">
          <span className="bi-cutoff-k">Next billing cutoff</span>
          <button className="bi-cutoff-date" onClick={() => setCutoffOpen((v) => !v)}>
            {nextRun.date.toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" })}
          </button>
          {cutoffOpen && (
            <div className="bi-cutoff-pop">
              <DatePicker value={cutoffOf(period, localCutoffs, defaultCutoffDay)} onChange={saveCutoff} />
            </div>
          )}
        </div>
      </div>

      {/* ---------- Fixed controls: 3 phase tabs + sort + filters ---------- */}
      <div className="bi-controls">
        <div className="bi-phaseseg" data-phase={phase}>
          <button className={phase === "tobill" ? "is-on" : ""} onClick={() => setPhase("tobill")}>
            To bill <i>{outstanding.length}</i>
          </button>
          <button className={phase === "sent" ? "is-on" : ""} onClick={() => { setPhase("sent"); setSelectMode(false); setSelected(new Set()); }}>
            Sent <i>{sentList.length}</i>
          </button>
          <button className={phase === "paid" ? "is-on" : ""} onClick={() => { setPhase("paid"); setSelectMode(false); setSelected(new Set()); }}>
            Paid <i>{paidList.length}</i>
          </button>
        </div>

        <div className="bi-filters">
          {phase === "tobill" && (
            <button
              className="bi-status-toggle"
              onClick={() => setStatus((s) => s === "billed" ? "scheduled" : s === "scheduled" ? "all" : "billed")}
              title="Click to cycle"
            >
              <span className="bi-status-dot" data-status={status} />
              {status === "billed" ? "Delivered" : status === "scheduled" ? "Scheduled" : "Both"}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M17 1l4 4-4 4M3 11V9a4 4 0 014-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 01-4 4H3" /></svg>
            </button>
          )}
          <div className="bi-search">
            <span className="bi-search-ico" aria-hidden="true">⌕</span>
            <input
              className="bi-search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search client, VAT…"
            />
            {query && <button className="bi-search-x" onClick={() => setQuery("")} aria-label="Clear">×</button>}
          </div>
          <div className="bi-filter bi-filter-sort">
            <Select value={sortKey} onChange={(v) => setSortKey(v as SortKey)} options={sortOptions} />
          </div>
          <div className="bi-filter">
            <Select value={fCompany} onChange={setFCompany}
              options={[{ value: "", label: "All companies" }, ...companyOptions]} placeholder="Company" />
          </div>
          <div className="bi-filter">
            <Select value={fType} onChange={setFType}
              options={[{ value: "", label: "All types" }, ...typeOptions]} placeholder="Type" />
          </div>
          {phase === "tobill" && (
            selectMode ? (
              <div className="bi-xlsx-group">
                <button
                  className="bi-xlsx"
                  disabled={selected.size === 0 || exporting}
                  onClick={exportSelected}
                  title={selected.size === 0 ? "Tick rows to export" : `Download ${selected.size} selected`}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <path d="M14 2v6h6" />
                    <path d="M9 13l3 4M12 13l-3 4" />
                  </svg>
                  {exporting ? "…" : `Download${selected.size ? ` (${selected.size})` : ""}`}
                </button>
                <button className="bi-xlsx-cancel"
                  onClick={() => { setSelectMode(false); setSelected(new Set()); }}>
                  Cancel
                </button>
              </div>
            ) : (
              <button className="bi-xlsx bi-xlsx-start" onClick={() => setSelectMode(true)} title="Select rows to export to Excel">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <path d="M14 2v6h6" />
                  <path d="M9 13l3 4M12 13l-3 4" />
                </svg>
                Excel
              </button>
            )
          )}
          {(anyFilter || query) && <button className="bi-clear" onClick={() => { setFCompany(""); setFType(""); setQuery(""); }}>Clear</button>}
        </div>
      </div>

      {/* ---------- Scrollable list ---------- */}
      <div className="bi-scroll">
        {!loaded ? (
          <p className="bi-empty">Loading invoices…</p>
        ) : phase === "tobill" ? (
          outstanding.length === 0 ? (
            <p className="bi-empty">Nothing to bill for these filters.</p>
          ) : (
            <div className="bi-list">
              <div className={`bi-listhead ${selectMode ? "bi-listhead-sel" : ""}`}>
                {selectMode && (
                  <span className="bi-selcell">
                    <input type="checkbox" className="bi-check" checked={allVisibleSelected}
                      onChange={toggleSelAll} title="Select all" />
                  </span>
                )}
                <span>Bill to</span><span>VAT</span><span>Billing contact</span>
                <span className="bi-r">Days</span><span className="bi-r">Amount</span><span />
              </div>
              {outstanding.map((b) => {
                const isOpen = open === b.key;
                const totalDays = b.lines.consultor + b.lines.supervision + b.lines.connector;
                const canDrop = !!dragEntry && dragEntry.projectId === b.projectId && dragEntry.fromPeriod !== b.period;
                const isDropHover = canDrop && dropTarget === b.key;
                return (
                  <div
                    className={`bi-row ${selectMode ? "bi-row-selectable" : ""} ${selected.has(b.key) ? "is-selected" : ""} ${isOpen ? "is-open" : ""} ${canDrop ? "is-droppable" : ""} ${isDropHover ? "is-drophover" : ""}`}
                    key={b.key}
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
                      <label className="bi-selcell" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" className="bi-check"
                          checked={selected.has(b.key)} onChange={() => toggleSel(b.key)} />
                      </label>
                    )}
                    <button className="bi-row-main" onClick={() => setOpen(isOpen ? null : b.key)}>
                      <span className="bi-to">
                        <span className="bi-legal">{b.legalName}<span className="bi-period-tag">{periodLabel(b.period)}</span>{canDrop && <span className="bi-drop-hint">drop to bill here</span>}</span>
                        <span className="bi-type">
                          {clientNames[b.clientId] ?? ""}{clientNames[b.clientId] ? " · " : ""}{b.type}
                          {b.address ? <span className="bi-addr"> — {b.address}</span> : null}
                        </span>
                      </span>
                      <span className="bi-vat">{b.vat || "—"}</span>
                      <span className="bi-contact">
                        {b.contact?.email ? (<><span>{b.contact.email}</span><em>{b.contact.name}</em></>) : "—"}
                      </span>
                      <span className="bi-r bi-days">{totalDays.toFixed(2)}<u>{unitOf(b.projectId)}</u></span>
                      <span className="bi-r bi-amount">
                        <b>{eur(gross(b))} €</b>
                      </span>
                      <span className={`bi-chev ${isOpen ? "is-open" : ""}`}>›</span>
                    </button>
                    {isOpen && (
                      <div className="bi-detail">
                        {billComposition(b)}
                        <div className="bi-detail-actions">
                          <span className="bi-detail-note">
                            Marking as sent records this invoice for {periodLabel(b.period)} and moves it to Sent.
                          </span>
                          <button className="bi-sendbtn" disabled={busy === b.key} onClick={() => markSent(b)}>
                            {busy === b.key ? "Saving…" : "Mark as sent →"}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )
        ) : (
          (() => {
            const list = phase === "sent" ? sentList : paidList;
            if (list.length === 0) return <p className="bi-empty">No {phase === "sent" ? "sent" : "paid"} invoices for these filters.</p>;
            return (
              <div className="bi-list">
                <div className="bi-listhead bi-sent-head">
                  <span>Client</span><span>Sent</span><span>Due</span>
                  <span className="bi-r">Amount</span><span>Status</span><span />
                </div>
                {list.map((inv) => {
                  // Status AS OF the selected month: an invoice paid later still
                  // reads as Sent/Overdue in the months before its payment.
                  const paidAsOf = wasPaidBy(inv);
                  const late = daysLateOf(inv);
                  const isOverdue = !paidAsOf && late > 0;
                  const invKey = `${inv.projectId}|${inv.period}`;
                  const comp = billByKey[invKey];
                  const isOpen = open === invKey;
                  const u = unitOf(inv.projectId);
                  return (
                    <div className={`bi-scard ${isOpen ? "is-open" : ""} ${isOverdue ? "is-overdue" : ""} ${paidAsOf ? "is-paid" : ""}`} key={inv.id}>
                      <div className="bi-sent-row" onClick={() => comp && setOpen(isOpen ? null : invKey)} style={{ cursor: comp ? "pointer" : "default" }}>
                        <span className="bi-scard-client">
                          <span className="bi-scard-name">{projName(inv.projectId)}</span>
                          <span className="bi-scard-meta">
                            <span className="bi-period-tag">{periodLabel(inv.period)}</span>
                            <span className="bi-scard-days">{inv.days.toFixed(2)}{u}</span>
                          </span>
                        </span>

                        <span className="bi-scard-when">
                          <em>Sent</em>{inv.sentDate || "—"}
                        </span>
                        <span className={`bi-scard-when ${isOverdue ? "is-overdue" : ""}`}>
                          <em>Due</em>{inv.dueDate || "—"}
                          {isOverdue && <span className="bi-late">{late}d late</span>}
                        </span>

                        <span className="bi-r bi-sent-amt">{eur(inv.amount)} €</span>

                        <span className={`bi-badge is-${paidAsOf ? "paid" : "sent"}${isOverdue ? " is-overdue" : ""}`}>
                          {paidAsOf ? "Paid" : isOverdue ? "Overdue" : "Awaiting"}
                          {paidAsOf && inv.paidDate && <em>{inv.paidDate}</em>}
                        </span>

                        <span className="bi-sent-actions">
                          {phase === "sent" && (
                            <button className="bi-unsend" disabled={busy === invKey}
                              onClick={(e) => { e.stopPropagation(); unsend(inv); }} title="Move back to To bill">
                              Unsend
                            </button>
                          )}
                          <button className={`bi-paybtn ${inv.status === "paid" ? "is-paid" : ""}`}
                            disabled={busy === invKey} onClick={(e) => { e.stopPropagation(); togglePaid(inv); }}>
                            {inv.status === "paid" ? "Undo" : "Mark paid"}
                          </button>
                        </span>
                      </div>
                      {isOpen && comp && <div className="bi-detail">{billComposition(comp)}</div>}
                    </div>
                  );
                })}
              </div>
            );
          })()
        )}
      </div>
    </div>
  );
}