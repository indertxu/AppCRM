/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { PageLoader } from "../../framework/AppLayout";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { supabase } from "../../api/supabase";
import { periodForDate, cutoffOf, type Cutoffs } from "../calendar/billingPeriods";
import DatePicker from "../../framework/DatePicker";
import Select from "../../framework/Select";
import { downloadBlob, sheetToXlsx, type XCell, type XStyle } from "../../framework/exportFile";
import { countryLabel } from "../contacts/contactProfile";
import BillingAdjustModal, { type SavePayload } from "./BillingAdjustModal";
import { lineRate, roleNameOf, roleColor, roleCounts, type ClientRole, type RoleLine } from "../clients/clientsTypes";
import { ClientLogo } from "../clients/ClientWorkspace";
import "./BillingPanel.css";
import { useNavSection } from "../../framework/pageAccess";

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
  /** The roles sold on the project: each bills at its own rate. */
  lines: RoleLine[];
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
  /** Catalogue roles, to name and colour each line of a bill. */
  roles: ClientRole[];
  hourProjects?: Set<string>;
  anchor?: Date;
  cutoffs?: Cutoffs;
  defaultCutoffDay?: number;
}

/** A bill line: the role the time was logged on (role id). */
type Line = string;
/** Days on each role of a bill. */
type Lines = Record<Line, number>;
const sumLines = (l: Lines) => Object.values(l).reduce((s, v) => s + v, 0);
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
  tune: "M4 6h10M18 6h2M4 12h2M10 12h10M4 18h14M20 18h0M14 4v4M6 10v4M18 16v4",
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
  /** The number it went out with, and its date (83_invoice_numbers.sql). */
  number?: string; issueDate?: string;
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
  /** The project's main rate: what a role not sold on the project bills at. */
  rate: number;
  /** Rate of each role sold on the project, its own discount applied. */
  rates: Record<Line, number>;
  taxed: boolean;
  taxRate: number;
  lines: Lines;
  rows: { id: string; date: string; userId: string; days: number; line: Line; status: string; moved?: boolean }[];
}

/* =====================================================================
   Invoices: a PDF for the client, built from a bill (or a sent invoice).
   What we put on it (our legal details, IBAN, the model invoice) lives with
   the company's document branding (proposal template › brand.invoice).
   ===================================================================== */
interface InvoiceSetup {
  issuer: string; vat: string; address: string; email: string; phone: string;
  iban: string; bank: string; payment: string; footer: string;
  lang: "es" | "en"; color: string; logo?: string;
  /** The model invoice uploaded here (its name, a picture of page 1, and its text). */
  modelName?: string; modelThumb?: string;
}
interface InvoiceDoc {
  number: string; issueDate: string; dueDate: string;
  client: { name: string; vat: string; address: string; email: string };
  lines: { desc: string; qty: number; unit: string; price: number; amount: number }[];
  vatPct: number; notes: string;
}
const INV_EMPTY: InvoiceSetup = { issuer: "", vat: "", address: "", email: "", phone: "", iban: "", bank: "", payment: "", footer: "", lang: "es", color: "0b3a2b" };
const INV_T = {
  es: { title: "FACTURA", no: "Nº factura", date: "Fecha", due: "Vencimiento", to: "Facturar a", vat: "CIF/NIF", desc: "Concepto", qty: "Cantidad", price: "Precio", amount: "Importe", sub: "Base imponible", tax: "IVA", total: "Total", pay: "Forma de pago", iban: "IBAN", bank: "Banco", days: "días", hours: "horas", day: "día", hour: "hora" },
  en: { title: "INVOICE", no: "Invoice no.", date: "Date", due: "Due date", to: "Bill to", vat: "VAT no.", desc: "Description", qty: "Qty", price: "Unit price", amount: "Amount", sub: "Subtotal", tax: "VAT", total: "Total", pay: "Payment", iban: "IBAN", bank: "Bank", days: "days", hours: "hours", day: "day", hour: "hour" },
};
const invMoney = (n: number, lang: "es" | "en") => `${n.toLocaleString(lang === "es" ? "es-ES" : "en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const invDate = (iso: string, lang: "es" | "en") => {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(lang === "es" ? "es-ES" : "en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
};
const invUnit = (l: { qty: number; unit: string }, T: (typeof INV_T)["es"]) => (l.unit === "h" ? (l.qty === 1 ? T.hour : T.hours) : (l.qty === 1 ? T.day : T.days));
const invTotals = (d: InvoiceDoc) => {
  const net = d.lines.reduce((s, l) => s + l.amount, 0);
  const vat = net * (d.vatPct / 100);
  return { net, vat, total: net + vat };
};
/** The next number after the highest one already used ("2026-0041" → "2026-0042"); the person can change it. */
function nextInvoiceNumber(used: string[]): string {
  let best: { pre: string; n: number; w: number; post: string } | null = null;
  used.forEach((u) => {
    const m = /^(.*?)(\d+)(\D*)$/.exec(u.trim());
    if (m && (!best || Number(m[2]) > best.n)) best = { pre: m[1], n: Number(m[2]), w: m[2].length, post: m[3] };
  });
  const b = best as { pre: string; n: number; w: number; post: string } | null;
  return b ? `${b.pre}${String(b.n + 1).padStart(b.w, "0")}${b.post}` : `${new Date().getFullYear()}-0001`;
}
/** Our company's details for invoices: what was set here, else the proposal branding. */
async function loadInvoiceSetup(): Promise<{ setup: InvoiceSetup; rowId: string | null; brand: any }> {
  const { data } = await supabase.from("proposal_templates").select("id, brand").eq("is_default", true).limit(1).maybeSingle();
  const brand = (data as any)?.brand ?? {};
  const own = brand.invoice ?? {};
  const setup: InvoiceSetup = {
    ...INV_EMPTY,
    issuer: brand.legalName || brand.company || "", vat: brand.vat ?? "", address: brand.address ?? "",
    email: brand.contact?.email ?? "", phone: brand.contact?.phone ?? "",
    color: String(brand.colors?.primary ?? INV_EMPTY.color).replace(/^#/, ""),
    logo: brand.assets?.logoLight || brand.assets?.logoDark || undefined,
    ...own,
  };
  return { setup, rowId: (data as any)?.id ?? null, brand };
}
async function saveInvoiceSetup(rowId: string | null, brand: any, setup: InvoiceSetup): Promise<string | null> {
  const { logo: _logo, ...keep } = setup;
  const next = { ...brand, invoice: keep };
  const r = rowId
    ? await supabase.from("proposal_templates").update({ brand: next, updated_at: new Date().toISOString() }).eq("id", rowId)
    : await supabase.from("proposal_templates").insert({ brand: next, is_default: true, name: "Default" });
  return r.error?.message ?? null;
}
/** A model invoice (PDF): a picture of its first page, and the details we can read off it (CIF, IBAN, e-mail). */
async function readModelInvoice(file: File): Promise<{ thumb: string; text: string }> {
  const pdfjs: any = await import("pdfjs-dist");
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    const w: any = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = w.default ?? w;
  }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, useSystemFonts: true }).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1.1 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
  await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
  const tc = await page.getTextContent();
  const text = (tc.items as any[]).map((i) => i.str).join(" ");
  try { await doc.destroy(); } catch { /* ignore */ }
  return { thumb: canvas.toDataURL("image/jpeg", 0.72), text };
}
/** The invoice as a PDF (A4). */
async function buildInvoicePdf(d: InvoiceDoc, s: InvoiceSetup): Promise<Blob> {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ unit: "mm", format: "a4" });
  const T = INV_T[s.lang];
  const hex = /^[0-9a-f]{6}$/i.test(s.color) ? s.color : INV_EMPTY.color;
  const C = [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)] as const;
  const W = 210, M = 18;
  const ink = () => pdf.setTextColor(20, 30, 26);
  const mute = () => pdf.setTextColor(110, 122, 117);
  // header band
  pdf.setFillColor(C[0], C[1], C[2]); pdf.rect(0, 0, W, 4, "F");
  let y = 18;
  if (s.logo) {
    try {
      const img = await new Promise<HTMLImageElement>((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = ko; i.src = s.logo!; });
      const h = 14, w = Math.min(60, (img.width / Math.max(1, img.height)) * h);
      pdf.addImage(s.logo, M, y - 6, w, h);
    } catch { /* no logo */ }
  } else { pdf.setFont("helvetica", "bold"); pdf.setFontSize(15); ink(); pdf.text(s.issuer || "—", M, y + 2); }
  pdf.setFont("helvetica", "bold"); pdf.setFontSize(22); pdf.setTextColor(C[0], C[1], C[2]);
  pdf.text(T.title, W - M, y + 2, { align: "right" });
  pdf.setFontSize(9); pdf.setFont("helvetica", "normal");
  const meta: [string, string][] = [[T.no, d.number || "—"], [T.date, invDate(d.issueDate, s.lang)], [T.due, invDate(d.dueDate, s.lang)]];
  meta.forEach(([k, v], i) => { mute(); pdf.text(k, W - M - 38, y + 10 + i * 5); ink(); pdf.setFont("helvetica", "bold"); pdf.text(v, W - M, y + 10 + i * 5, { align: "right" }); pdf.setFont("helvetica", "normal"); });
  // issuer
  y = 46;
  pdf.setFontSize(9.5); pdf.setFont("helvetica", "bold"); ink(); pdf.text(s.issuer || "", M, y);
  pdf.setFont("helvetica", "normal"); mute();
  const iss = [s.vat ? `${T.vat} ${s.vat}` : "", ...pdf.splitTextToSize(s.address || "", 80), [s.email, s.phone].filter(Boolean).join(" · ")].filter(Boolean);
  iss.forEach((l: string, i: number) => pdf.text(l, M, y + 5 + i * 4.3));
  // client box
  const bx = 112, bw = W - M - bx;
  pdf.setDrawColor(225, 232, 228); pdf.setFillColor(246, 249, 247); pdf.roundedRect(bx, y - 6, bw, 34, 2.5, 2.5, "FD");
  pdf.setFontSize(7.5); pdf.setTextColor(C[0], C[1], C[2]); pdf.setFont("helvetica", "bold"); pdf.text(T.to.toUpperCase(), bx + 5, y);
  pdf.setFontSize(10); ink(); pdf.text(pdf.splitTextToSize(d.client.name || "—", bw - 10)[0] ?? "", bx + 5, y + 5.5);
  pdf.setFont("helvetica", "normal"); pdf.setFontSize(8.8); mute();
  const cl = [d.client.vat ? `${T.vat} ${d.client.vat}` : "", ...pdf.splitTextToSize(d.client.address || "", bw - 10), d.client.email].filter(Boolean).slice(0, 5);
  cl.forEach((l: string, i: number) => pdf.text(l, bx + 5, y + 10.5 + i * 4.2));
  // lines
  y = 92;
  const cols = [M, 128, 152, W - M];
  pdf.setFillColor(C[0], C[1], C[2]); pdf.rect(M, y - 5.5, W - 2 * M, 8, "F");
  pdf.setTextColor(255, 255, 255); pdf.setFont("helvetica", "bold"); pdf.setFontSize(8.5);
  pdf.text(T.desc, cols[0] + 3, y); pdf.text(T.qty, cols[1] + 14, y, { align: "right" }); pdf.text(T.price, cols[2] + 18, y, { align: "right" }); pdf.text(T.amount, cols[3] - 3, y, { align: "right" });
  y += 8; pdf.setFont("helvetica", "normal"); pdf.setFontSize(9);
  d.lines.forEach((l, i) => {
    const desc = pdf.splitTextToSize(l.desc, cols[1] - cols[0] - 6) as string[];
    const h = Math.max(7, desc.length * 4.3 + 3);
    if (i % 2 === 1) { pdf.setFillColor(248, 250, 249); pdf.rect(M, y - 4.6, W - 2 * M, h, "F"); }
    ink(); pdf.text(desc, cols[0] + 3, y);
    mute(); pdf.text(`${(+l.qty.toFixed(2)).toLocaleString(s.lang === "es" ? "es-ES" : "en-GB")} ${invUnit(l, T)}`, cols[1] + 14, y, { align: "right" });
    pdf.text(invMoney(l.price, s.lang), cols[2] + 18, y, { align: "right" });
    ink(); pdf.text(invMoney(l.amount, s.lang), cols[3] - 3, y, { align: "right" });
    y += h;
  });
  pdf.setDrawColor(225, 232, 228); pdf.line(M, y - 2, W - M, y - 2);
  // totals
  const t = invTotals(d);
  y += 6;
  const tx = 128;
  ([[T.sub, invMoney(t.net, s.lang)], [`${T.tax} ${d.vatPct}%`, invMoney(t.vat, s.lang)]] as [string, string][]).forEach(([k, v]) => {
    mute(); pdf.text(k, tx, y); ink(); pdf.text(v, W - M - 3, y, { align: "right" }); y += 6;
  });
  pdf.setFillColor(C[0], C[1], C[2]); pdf.roundedRect(tx - 4, y - 5, W - M - tx + 4, 10, 2, 2, "F");
  pdf.setTextColor(255, 255, 255); pdf.setFont("helvetica", "bold"); pdf.setFontSize(11);
  pdf.text(T.total, tx, y + 1.6); pdf.text(invMoney(t.total, s.lang), W - M - 3, y + 1.6, { align: "right" });
  // payment & notes
  y += 18; pdf.setFontSize(8.5);
  const pay = [s.payment, s.iban ? `${T.iban}: ${s.iban}` : "", s.bank ? `${T.bank}: ${s.bank}` : ""].filter(Boolean);
  if (pay.length) {
    pdf.setFont("helvetica", "bold"); pdf.setTextColor(C[0], C[1], C[2]); pdf.text(T.pay.toUpperCase(), M, y);
    pdf.setFont("helvetica", "normal"); ink(); pay.forEach((l, i) => pdf.text(pdf.splitTextToSize(l, 120), M, y + 5 + i * 4.5));
    y += 5 + pay.length * 4.5 + 4;
  }
  if (d.notes.trim()) { mute(); pdf.text(pdf.splitTextToSize(d.notes.trim(), W - 2 * M), M, y + 2); }
  if (s.footer.trim()) { pdf.setFontSize(7.5); mute(); pdf.text(pdf.splitTextToSize(s.footer.trim(), W - 2 * M), W / 2, 285, { align: "center" }); }
  return pdf.output("blob");
}

/** The invoice editor: the number, dates, the client and its lines, a live preview, and the PDF. */
function InvoiceModal({ doc0, used, title, onClose, onDone }: {
  doc0: InvoiceDoc; used: string[]; title: string;
  onClose: () => void;
  /** After the PDF is downloaded: the number and date it went out with. */
  onDone?: (d: { number: string; issueDate: string }) => void;
}) {
  const [d, setD] = useState<InvoiceDoc>(() => ({ ...doc0, number: doc0.number || nextInvoiceNumber(used) }));
  const [setup, setSetup] = useState<InvoiceSetup | null>(null);
  const [row, setRow] = useState<{ id: string | null; brand: any }>({ id: null, brand: {} });
  const [tab, setTab] = useState<"invoice" | "setup">("invoice");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { loadInvoiceSetup().then((r) => { setSetup(r.setup); setRow({ id: r.rowId, brand: r.brand }); if (!r.setup.issuer) setTab("setup"); }).catch(() => setSetup(INV_EMPTY)); }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [busy, onClose]);
  const set = (p: Partial<InvoiceDoc>) => setD((x) => ({ ...x, ...p }));
  const setC = (p: Partial<InvoiceDoc["client"]>) => setD((x) => ({ ...x, client: { ...x.client, ...p } }));
  const setL = (i: number, p: Partial<InvoiceDoc["lines"][number]>) => setD((x) => ({ ...x, lines: x.lines.map((l, j) => {
    if (j !== i) return l;
    const n = { ...l, ...p };
    if (p.qty !== undefined || p.price !== undefined) n.amount = +(n.qty * n.price).toFixed(2);
    return n;
  }) }));
  const S = (p: Partial<InvoiceSetup>) => setSetup((x) => ({ ...(x ?? INV_EMPTY), ...p }));
  const s = setup ?? INV_EMPTY;
  const T = INV_T[s.lang];
  const t = invTotals(d);
  /** The number this invoice already went out with here (it isn't "used" by another one). */
  const [mine, setMine] = useState(doc0.number);
  const dup = !!d.number.trim() && used.includes(d.number.trim()) && d.number.trim() !== mine;

  const saveSetup = async () => {
    setBusy("setup"); setMsg(null);
    const e = await saveInvoiceSetup(row.id, row.brand, s);
    setBusy(null);
    setMsg(e ? { ok: false, text: e } : { ok: true, text: "Saved — every invoice uses these details." });
    if (!e) { const r = await loadInvoiceSetup().catch(() => null); if (r) setRow({ id: r.rowId, brand: r.brand }); }
  };
  const uploadModel = async (f: File) => {
    if (!/pdf$/i.test(f.type) && !/\.pdf$/i.test(f.name)) { setMsg({ ok: false, text: "Upload the model invoice as a PDF." }); return; }
    setBusy("model"); setMsg(null);
    try {
      const { thumb, text } = await readModelInvoice(f);
      const iban = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){4,7}(?:[ ]?[A-Z0-9]{1,3})?\b/.exec(text)?.[0];
      const ids = [...text.matchAll(/\b(?:ES)?([A-HJ-NP-SUVW]\d{7}[0-9A-J]|\d{8}[A-Z])\b/g)].map((m) => m[0]);
      const mail = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(text)?.[0];
      S({ modelName: f.name, modelThumb: thumb, iban: s.iban || iban || "", vat: s.vat || ids[0] || "", email: s.email || mail || "" });
      setMsg({ ok: true, text: `Model read${iban || ids[0] || mail ? " — its IBAN, tax ID and e-mail filled the blanks" : ""}. Check the details and save.` });
    } catch (e: any) { setMsg({ ok: false, text: `Couldn't read that PDF: ${e?.message ?? e}` }); }
    setBusy(null);
  };
  const download = async () => {
    if (!d.number.trim()) { setMsg({ ok: false, text: "Give the invoice a number." }); return; }
    setBusy("pdf"); setMsg(null);
    try {
      const blob = await buildInvoicePdf(d, s);
      downloadBlob(blob, `${s.lang === "es" ? "Factura" : "Invoice"} ${d.number.replace(/[\\/:*?"<>|]/g, "-")} ${d.client.name}.pdf`.replace(/\s+/g, " "));
      onDone?.({ number: d.number.trim(), issueDate: d.issueDate });
      setMine(d.number.trim());
      setMsg({ ok: true, text: `Invoice ${d.number} downloaded.` });
    } catch (e: any) { setMsg({ ok: false, text: `Couldn't build the PDF: ${e?.message ?? e}` }); }
    setBusy(null);
  };

  // over the whole app (the Management header sits above the panel's own layer)
  return createPortal(
    <div className="bn ivm-host"><div className="bn-pop-backdrop" onMouseDown={() => !busy && onClose()}>
      <div className="bn-pop ivm" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Invoice">
        <header className="bn-pop-head">
          <span className="bn-pop-ico"><BnIcon d={BN_ICON.out} w={2} /></span>
          <div><h3>Invoice · {title}</h3><small>{tab === "invoice" ? "Check it, then download the PDF to send to the client" : "Your company's details on every invoice"}</small></div>
          <div className="ivm-tabs" role="tablist">
            {(["invoice", "setup"] as const).map((k) => (
              <button type="button" key={k} role="tab" aria-selected={tab === k} className={tab === k ? "is-on" : ""} onClick={() => setTab(k)}>{k === "invoice" ? "Invoice" : "Our details & model"}</button>
            ))}
          </div>
          <button type="button" className="bn-pop-x" onClick={onClose} aria-label="Close"><BnIcon d={BN_ICON.x} w={2.4} /></button>
        </header>
        <div className="ivm-body">
          <div className="ivm-form">
            {tab === "invoice" ? (
              <>
                <div className="ivm-grid">
                  <label className={`ivm-f ${dup ? "is-warn" : ""}`}><span>Invoice no.</span><input value={d.number} onChange={(e) => set({ number: e.target.value })} placeholder="2026-0001" />{dup && <em>Already used</em>}</label>
                  <label className="ivm-f"><span>Date</span><DatePicker value={d.issueDate} onChange={(v) => v && set({ issueDate: v })} /></label>
                  <label className="ivm-f"><span>Due</span><DatePicker value={d.dueDate} onChange={(v) => v && set({ dueDate: v })} /></label>
                  <label className="ivm-f"><span>VAT %</span><input type="number" min={0} step={0.5} value={d.vatPct} onChange={(e) => set({ vatPct: Math.max(0, Number(e.target.value) || 0) })} /></label>
                </div>
                <p className="ivm-sub">Bill to</p>
                <div className="ivm-grid">
                  <label className="ivm-f is-wide"><span>Legal name</span><input value={d.client.name} onChange={(e) => setC({ name: e.target.value })} /></label>
                  <label className="ivm-f"><span>Tax ID</span><input value={d.client.vat} onChange={(e) => setC({ vat: e.target.value })} /></label>
                  <label className="ivm-f"><span>Invoice e-mail</span><input value={d.client.email} onChange={(e) => setC({ email: e.target.value })} /></label>
                  <label className="ivm-f is-wide"><span>Address</span><input value={d.client.address} onChange={(e) => setC({ address: e.target.value })} /></label>
                </div>
                <p className="ivm-sub">Lines</p>
                <div className="ivm-lines">
                  {d.lines.map((l, i) => (
                    <div className="ivm-line" key={i}>
                      <input className="ivm-desc" value={l.desc} onChange={(e) => setL(i, { desc: e.target.value })} aria-label="Description" />
                      <input type="number" step={0.25} value={l.qty} onChange={(e) => setL(i, { qty: Number(e.target.value) || 0 })} aria-label="Quantity" />
                      <input type="number" step={10} value={l.price} onChange={(e) => setL(i, { price: Number(e.target.value) || 0 })} aria-label="Unit price" />
                      <b>{invMoney(l.amount, s.lang)}</b>
                    </div>
                  ))}
                </div>
                <label className="ivm-f is-wide"><span>Note on the invoice <i>optional</i></span><input value={d.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="e.g. PO 4500123 · Project Data platform" /></label>
              </>
            ) : (
              <>
                <div className="ivm-model">
                  {s.modelThumb ? <img src={s.modelThumb} alt="Model invoice" /> : <span className="ivm-model-empty"><BnIcon d={BN_ICON.out} w={1.8} /></span>}
                  <div>
                    <b>{s.modelName || "Your model invoice"}</b>
                    <small>Upload an invoice of yours (PDF): its IBAN, tax ID and e-mail are read into the details below, and it stays here as the reference.</small>
                    <button type="button" className="bn-act is-ghost" disabled={busy === "model"} onClick={() => fileRef.current?.click()}>{busy === "model" ? "Reading…" : s.modelName ? "Replace PDF" : "Upload PDF"}</button>
                    <input ref={fileRef} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadModel(f); }} />
                  </div>
                </div>
                <div className="ivm-grid">
                  <label className="ivm-f is-wide"><span>Legal name</span><input value={s.issuer} onChange={(e) => S({ issuer: e.target.value })} placeholder="Konsolidator Spain, S.L." /></label>
                  <label className="ivm-f"><span>Tax ID</span><input value={s.vat} onChange={(e) => S({ vat: e.target.value })} placeholder="B12345678" /></label>
                  <label className="ivm-f"><span>Language</span>
                    <Select value={s.lang} onChange={(v) => S({ lang: v as "es" | "en" })} options={[{ value: "es", label: "Spanish (Factura)" }, { value: "en", label: "English (Invoice)" }]} /></label>
                  <label className="ivm-f is-wide"><span>Address</span><input value={s.address} onChange={(e) => S({ address: e.target.value })} placeholder="Calle Serrano 1, 28001 Madrid" /></label>
                  <label className="ivm-f"><span>E-mail</span><input value={s.email} onChange={(e) => S({ email: e.target.value })} /></label>
                  <label className="ivm-f"><span>Phone</span><input value={s.phone} onChange={(e) => S({ phone: e.target.value })} /></label>
                  <label className="ivm-f is-wide"><span>IBAN</span><input value={s.iban} onChange={(e) => S({ iban: e.target.value })} placeholder="ES00 0000 0000 0000 0000 0000" /></label>
                  <label className="ivm-f"><span>Bank</span><input value={s.bank} onChange={(e) => S({ bank: e.target.value })} /></label>
                  <label className="ivm-f"><span>Colour</span><input value={`#${s.color}`} onChange={(e) => S({ color: e.target.value.replace(/^#/, "").slice(0, 6) })} /></label>
                  <label className="ivm-f is-wide"><span>Payment line</span><input value={s.payment} onChange={(e) => S({ payment: e.target.value })} placeholder="Transferencia bancaria a 30 días fecha factura" /></label>
                  <label className="ivm-f is-wide"><span>Footer</span><input value={s.footer} onChange={(e) => S({ footer: e.target.value })} placeholder="Inscrita en el Registro Mercantil de Madrid…" /></label>
                </div>
              </>
            )}
          </div>
          {/* the page as it will come out */}
          <div className="ivm-prev" aria-label="Preview">
            <div className="ivm-page" style={bnVars({ "--ic": `#${/^[0-9a-f]{6}$/i.test(s.color) ? s.color : INV_EMPTY.color}` })}>
              <div className="ivm-p-top">
                {s.logo ? <img src={s.logo} alt="" /> : <b className="ivm-p-co">{s.issuer || "Your company"}</b>}
                <div className="ivm-p-meta"><strong>{T.title}</strong>
                  <span><i>{T.no}</i>{d.number || "—"}</span><span><i>{T.date}</i>{invDate(d.issueDate, s.lang)}</span><span><i>{T.due}</i>{invDate(d.dueDate, s.lang)}</span></div>
              </div>
              <div className="ivm-p-parties">
                <div><b>{s.issuer || "—"}</b>{s.vat && <span>{T.vat} {s.vat}</span>}<span>{s.address}</span><span>{[s.email, s.phone].filter(Boolean).join(" · ")}</span></div>
                <div className="ivm-p-to"><i>{T.to}</i><b>{d.client.name || "—"}</b>{d.client.vat && <span>{T.vat} {d.client.vat}</span>}<span>{d.client.address}</span><span>{d.client.email}</span></div>
              </div>
              <div className="ivm-p-table">
                <div className="is-head"><span>{T.desc}</span><span>{T.qty}</span><span>{T.price}</span><span>{T.amount}</span></div>
                {d.lines.map((l, i) => (
                  <div key={i}><span>{l.desc}</span><span>{+l.qty.toFixed(2)} {invUnit(l, T)}</span><span>{invMoney(l.price, s.lang)}</span><span>{invMoney(l.amount, s.lang)}</span></div>
                ))}
              </div>
              <div className="ivm-p-tot">
                <span><i>{T.sub}</i>{invMoney(t.net, s.lang)}</span>
                <span><i>{T.tax} {d.vatPct}%</i>{invMoney(t.vat, s.lang)}</span>
                <strong><i>{T.total}</i>{invMoney(t.total, s.lang)}</strong>
              </div>
              {(s.payment || s.iban) && <div className="ivm-p-pay"><i>{T.pay}</i>{s.payment && <span>{s.payment}</span>}{s.iban && <span>{T.iban}: {s.iban}</span>}{s.bank && <span>{T.bank}: {s.bank}</span>}</div>}
              {d.notes && <p className="ivm-p-note">{d.notes}</p>}
              {s.footer && <p className="ivm-p-foot">{s.footer}</p>}
            </div>
          </div>
        </div>
        <footer className="bn-pop-foot ivm-foot">
          {msg && <span className={`ivm-msg ${msg.ok ? "is-ok" : "is-err"}`}>{msg.text}</span>}
          <button type="button" className="bn-act is-ghost" onClick={onClose} disabled={!!busy}>Close</button>
          {tab === "setup"
            ? <button type="button" className="bn-act is-pay" onClick={() => void saveSetup()} disabled={busy === "setup"}>{busy === "setup" ? "Saving…" : "Save details"}</button>
            : <button type="button" className="bn-act is-pay" onClick={() => void download()} disabled={busy === "pdf" || !setup}>{busy === "pdf" ? "Building…" : "Download PDF"}</button>}
        </footer>
      </div>
    </div></div>,
    document.body,
  );
}

export default function BillingPanel({
  entries, projects, clientNames, typeNames, people, roles,
  hourProjects = new Set(), anchor = new Date(), cutoffs = {}, defaultCutoffDay = 0,
}: Props) {
  /** "h" if the bill's project is billed by the hour, otherwise "d". */
  const unitOf = (projectId: string) => (hourProjects.has(projectId) ? "h" : "d");
  const [open, setOpen] = useState<string | null>(null);
  // The bill currently open in the adjustment modal (by bill.key), plus its
  // frozen invoice if it has one.
  const [adjusting, setAdjusting] = useState<{ bill: Bill; invoice: Invoice | null } | null>(null);
  // Bills that already carry a saved adjustment (key = "projectId|period"),
  // with their latest version — drives the "modified" dot in the list.
  const [adjustedBills, setAdjustedBills] = useState<Record<string, number>>({});
  // Per bill, the latest adjustment applied to the entries it shows:
  //   key -> { entryId -> { daysAfter, removed } }  (only changed entries)
  const [adjustMap, setAdjustMap] = useState<Record<string, Record<string, { daysAfter: number; removed: boolean }>>>({});

  const loadAdjustments = async () => {
    // Latest adjustment per (project, period), plus the entry-level changes.
    const { data: adjs } = await supabase
      .from("invoice_adjustments")
      .select("id, project_id, period, version")
      .order("version", { ascending: true });
    const latest: Record<string, { id: string; version: number }> = {};
    ((adjs ?? []) as any[]).forEach((a) => {
      const k = `${a.project_id}|${a.period}`;
      // ascending order → the last one seen per key is the highest version
      latest[k] = { id: a.id, version: a.version };
    });
    const verMap: Record<string, number> = {};
    Object.entries(latest).forEach(([k, v]) => { verMap[k] = v.version; });
    setAdjustedBills(verMap);

    const latestIds = Object.values(latest).map((v) => v.id);
    if (latestIds.length === 0) { setAdjustMap({}); return; }
    const { data: lines } = await supabase
      .from("invoice_adjustment_lines")
      .select("adjustment_id, entry_id, days_after, removed")
      .in("adjustment_id", latestIds);
    // adjustment_id -> its key
    const idToKey: Record<string, string> = {};
    Object.entries(latest).forEach(([k, v]) => { idToKey[v.id] = k; });
    const map: Record<string, Record<string, { daysAfter: number; removed: boolean }>> = {};
    ((lines ?? []) as any[]).forEach((l) => {
      const k = idToKey[l.adjustment_id];
      if (!k || !l.entry_id) return;
      (map[k] ??= {})[l.entry_id] = { daysAfter: Number(l.days_after) || 0, removed: !!l.removed };
    });
    setAdjustMap(map);
  };

  // Load adjustments once on mount.
  useEffect(() => { loadAdjustments(); }, []);

  /** Persist a previewed adjustment via the atomic RPC. Returns an error
      message to show in the modal, or null on success. */
  /** Rate a bill's line is charged at. */
  const rateOf = (b: { rate: number; rates: Record<string, number> }, line: Line) => b.rates[line] ?? b.rate;
  /** Name, colour and order of a line (role). */
  const lineLabel = (ln: Line) => roleNameOf(ln, roles);
  const lineColor = (ln: Line) => { const at = roles.findIndex((r) => r.id === ln); return roleColor(roles[at], at < 0 ? 0 : at); };
  const lineOrder = (ln: Line) => { const at = roles.findIndex((r) => r.id === ln); return at < 0 ? 999 : at; };
  const linesOf = (l: Lines) => Object.keys(l).sort((a, b) => lineOrder(a) - lineOrder(b));

  const saveAdjustment = async (p: SavePayload): Promise<string | null> => {
    const { error } = await supabase.rpc("save_billing_adjustment", {
      p_project_id: p.projectId,
      p_client_id: p.clientId,
      p_period: p.period,
      p_invoice_id: p.invoiceId,
      p_orig_net: p.orig.net,
      p_orig_amount: p.orig.amount,
      p_orig_days: p.orig.days,
      p_taxed: p.orig.taxed,
      p_tax_rate: p.orig.taxRate,
      p_rate: p.orig.rate,
      p_supervision_rate: p.orig.supervisionRate,
      p_rates: p.orig.rates,
      p_orig_lines: p.origLines,
      p_net_after: p.after.net,
      p_amount_after: p.after.amount,
      p_days_after: p.after.days,
      p_note: p.note,
      p_changes: p.changes,
    });
    if (error) {
      // The locker's "can't go negative" guard surfaces here.
      if (/withdraw|negative|only/i.test(error.message)) {
        return "Not enough saved days in this client's locker for that increase.";
      }
      return error.message;
    }
    // Reload adjustments so the list shows the post-edit values (dropped/edited
    // entries, new totals) and the modified marker.
    await loadAdjustments();
    return null;
  };
  /** Bills ticked for Excel export (To-bill tab only). Keyed by bill.key. */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  /** "Did you download the report?" check shown before marking a bill as sent. */
  const [sendAsk, setSendAsk] = useState<{ bill: Bill; downloaded: boolean } | null>(null);
  /** The invoice being prepared (a bill to send, or one already sent). */
  const [invoicing, setInvoicing] = useState<{ doc: InvoiceDoc; title: string; billKey?: string; invoiceId?: string } | null>(null);
  /** Numbers given to bills not marked as sent yet (they go with the invoice once it is). */
  const [invMeta, setInvMeta] = useState<Record<string, { number: string; issueDate: string }>>({});
  useEffect(() => {
    if (!sendAsk) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSendAsk(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sendAsk]);
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
  useNavSection("/management", 1, (part) => { if (["tobill", "sent", "paid", "history"].includes(part)) setPhase(part as Phase); }, "billing");
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
        status: r.status ?? "sent", number: r.number ?? "", issueDate: r.issue_date ?? "",
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

  // The billing line follows the role the user picked when logging, NOT their
  // role on the project team. Someone who is the PM can still log consultancy
  // work at the consultancy rate if they choose to.
  const lineOf = (_p: BiProj, line: string, _userId: string): Line => line;
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
          rate: (() => { const m = p.lines.find((l) => roleCounts(l.roleId, roles)) ?? p.lines[0]; return m ? lineRate(m) : 0; })(),
          rates: Object.fromEntries(p.lines.map((l) => [l.roleId, lineRate(l)])),
          taxed: p.taxed,
          taxRate: p.taxRate,
          lines: {},
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
      bill.lines[bucket] = (bill.lines[bucket] ?? 0) + e.billable;
      bill.rows.push({ id: e.id, date: e.date, userId: e.userId, days: e.billable, line: bucket, status: e.status, moved: !!override && override !== periodForDate(e.date, localCutoffs, defaultCutoffDay) });
    });

    return Object.values(acc)
      // A bill needs at least one row AND some billable value. Periods that
      // hold only non-billable work (internal, demos, client prep) would
      // otherwise appear as phantom 0.00 invoices in the To-bill tab.
      .filter((b) => b.rows.length > 0 && sumLines(b.lines) > 0)
      .map((b) => {
        const sorted = b.rows.sort((x, y) => x.date.localeCompare(y.date));
        const adj = adjustMap[b.key];
        if (!adj) return { ...b, rows: sorted };
        // Apply the latest saved adjustment: drop removed entries, take the
        // adjusted day counts, and recompute the line totals from what's left.
        const rows = sorted
          .filter((r) => !adj[r.id]?.removed)
          .map((r) => (adj[r.id] ? { ...r, days: adj[r.id].daysAfter } : r));
        const lines: Lines = {};
        rows.forEach((r) => { lines[r.line] = (lines[r.line] ?? 0) + r.days; });
        return { ...b, rows, lines };
      })
      // A bill whose adjustment emptied it out drops off the list.
      .filter((b) => b.rows.length > 0 && sumLines(b.lines) > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, projects, clientNames, typeNames, roles, status, localCutoffs, defaultCutoffDay, localMoves, adjustMap]);

  /** An invoice without VAT (older rows saved without a net figure fall back to the total). */
  const netOf = (i: Invoice) => (i.net > 0 || i.amount === 0 ? i.net : i.amount);
  const net = (b: Bill) =>
    Object.entries(b.lines).reduce((s, [ln, d]) => s + d * rateOf(b, ln), 0);
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
      const rate = rateOf(b, r.line);
      per[r.userId].days += r.days;
      per[r.userId].value += r.days * rate;
    });
    return Object.entries(per).sort((a, b2) => b2[1].value - a[1].value);
  };

  // Local calendar date (YYYY-MM-DD). toISOString() would shift to UTC and,
  // in Spain, turn local midnight into the previous day.
  const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

  /** The invoice of a bill: one line per role (days × its rate), or what a sent invoice froze. */
  const docFromBill = (b: Bill | null, inv?: Invoice): InvoiceDoc => {
    const pid = b?.projectId ?? inv?.projectId ?? "";
    const p = projects[pid];
    const per = periodLabel(b?.period ?? inv?.period ?? "");
    const u = unitOf(pid);
    const a: any = p?.address ?? {};
    const addr = typeof a === "string" ? a : [[a.street, a.number].filter(Boolean).join(" "), a.details, [postalOf(a), a.city].filter(Boolean).join(" "), a.country ? countryLabel(a.country) : ""].filter(Boolean).join(", ");
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const due = new Date(today); due.setDate(due.getDate() + paymentDays);
    const type = b?.type ?? typeNames[p?.typeId ?? ""] ?? "";
    let lines: InvoiceDoc["lines"] = b ? Object.entries(b.lines).filter(([, dd]) => dd > 0).map(([ln, dd]) => ({
      desc: [type, Object.keys(b.lines).length > 1 ? roleNameOf(ln, roles) : "", per].filter(Boolean).join(" · "),
      qty: +dd.toFixed(2), unit: u, price: +rateOf(b, ln).toFixed(2), amount: +(dd * rateOf(b, ln)).toFixed(2),
    })) : [];
    // a sent invoice keeps what it was sent with
    if (inv && (!lines.length || Math.abs(lines.reduce((x, l) => x + l.amount, 0) - netOf(inv)) > 0.01)) {
      const days = inv.days || 1;
      lines = [{ desc: [type, per].filter(Boolean).join(" · "), qty: +days.toFixed(2), unit: u, price: +(netOf(inv) / days).toFixed(2), amount: +netOf(inv).toFixed(2) }];
    }
    const taxed = b ? b.taxed : !!p?.taxed;
    const rate = b ? b.taxRate : p?.taxRate ?? 0;
    const vatPct = taxed ? rate : inv && netOf(inv) > 0 ? +(((inv.amount / netOf(inv)) - 1) * 100).toFixed(2) : 0;
    return {
      number: inv?.number ?? (b ? invMeta[b.key]?.number : "") ?? "",
      issueDate: inv?.issueDate || inv?.sentDate || isoDate(today),
      dueDate: inv?.dueDate || isoDate(due),
      client: { name: p?.legalName || clientNames[p?.clientId ?? ""] || "", vat: p?.vat ?? "", address: addr, email: billingContact(p?.contacts ?? [])?.email ?? "" },
      lines, vatPct, notes: "",
    };
  };
  const usedNumbers = [...invoices.map((i) => i.number ?? ""), ...Object.values(invMeta).map((m) => m.number)].filter(Boolean);
  /** The number a sent invoice went out with is kept on it. */
  const keepNumber = async (invoiceId: string, m: { number: string; issueDate: string }) => {
    setInvoices((prev) => prev.map((i) => (i.id === invoiceId ? { ...i, number: m.number, issueDate: m.issueDate } : i)));
    await supabase.from("invoices").update({ number: m.number, issue_date: m.issueDate }).eq("id", invoiceId);
  };

  const markSent = async (b: Bill) => {
    setBusy(b.key);
    // Sent date is the day it is actually marked as sent (today), not the
    // period's cutoff; the due date counts from there.
    const sent = new Date(); sent.setHours(0, 0, 0, 0);
    const due = new Date(sent); due.setDate(due.getDate() + paymentDays);
    const rowDays = sumLines(b.lines);
    const payload = {
      project_id: b.projectId, period: b.period,
      net: +net(b).toFixed(2), amount: +gross(b).toFixed(2), days: rowDays,
      sent_date: isoDate(sent), due_date: isoDate(due), status: "sent", paid_date: null,
    };
    // the invoice number given in the PDF goes with it
    const meta = invMeta[b.key];
    let { data, error } = await supabase.from("invoices").upsert((meta ? { ...payload, number: meta.number, issue_date: meta.issueDate } : payload) as Record<string, unknown>, { onConflict: "project_id,period" }).select().maybeSingle();
    if (error && meta && /number|issue_date/i.test(error.message)) ({ data, error } = await supabase.from("invoices").upsert(payload, { onConflict: "project_id,period" }).select().maybeSingle());
    if (data) {
      const inv: Invoice = {
        id: data.id, projectId: data.project_id, period: data.period,
        net: Number(data.net), amount: Number(data.amount), days: Number(data.days),
        sentDate: data.sent_date ?? "", dueDate: data.due_date ?? "", paidDate: "", status: data.status,
        number: data.number ?? meta?.number ?? "", issueDate: data.issue_date ?? meta?.issueDate ?? "",
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
  const recomputeInvoice = async (inv: Invoice, b: Bill, override?: Lines) => {
    const key = `${inv.projectId}|${inv.period}`;
    setBusy(key);
    const ln = override ?? b.lines;
    const days = +sumLines(ln).toFixed(2);
    const newNet = +Object.entries(ln).reduce((s, [k, d]) => s + d * rateOf(b, k), 0).toFixed(2);
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
    return [...agg.entries()]
      .map(([k, days]) => { const [line, userId] = k.split("|"); return { line: line as Line, userId, days: String(+days.toFixed(2)) }; })
      .sort((a, b2) => lineOrder(a.line) - lineOrder(b2.line) || (people[a.userId] ?? "").localeCompare(people[b2.userId] ?? ""));
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
      const days = +sumLines(t.comp.lines).toFixed(2);
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
      if (sortKey === "amount_asc") return net(a) - net(b);
      if (sortKey === "date_asc") return a.period.localeCompare(b.period);
      if (sortKey === "date_desc") return b.period.localeCompare(a.period);
      return net(b) - net(a);
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
      if (sortKey === "amount_asc") return netOf(a) - netOf(b);
      if (sortKey === "amount_desc") return netOf(b) - netOf(a);
      if (sortKey === "date_asc") return (a.sentDate || "").localeCompare(b.sentDate || "");
      if (sortKey === "date_desc") return (b.sentDate || "").localeCompare(a.sentDate || "");
      if (sortKey === "expired") return daysLateOf(b) - daysLateOf(a);
      return netOf(b) - netOf(a);
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
   * work on several roles is split into one row per role, each at its own
   * rate, labelled in column A with the role's name (e.g. "Main Consultant" /
   * "Project Manager"). Amounts are live formulas (price × days) with totals.
   */
  const exportSelected = async (only?: Bill[]) => {
    const chosen = only ?? outstanding.filter((b) => selected.has(b.key));
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
        const parts: Part[] = linesOf(b.lines)
          .filter((ln) => b.lines[ln] > 0)
          .map((ln) => ({ role: lineLabel(ln), days: b.lines[ln], rate: rateOf(b, ln) }));
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
  // Amounts are shown WITHOUT VAT, like Management → Team, so the two agree;
  // the VAT appears as a small note. Invoices still store and charge the total.
  const outstandingBills = bills.filter((b) => !billedBy(b.key) && b.period <= period);
  const outstandingTotal = outstandingBills.reduce((s, b) => s + net(b), 0);
  const outstandingVat = outstandingBills.reduce((s, b) => s + gross(b) - net(b), 0);
  const outstandingCount = bills.filter((b) => !billedBy(b.key) && b.period <= period).length;
  // Header snapshot AS OF the selected month.
  const sentTotal = invoices.filter((i) => wasSentBy(i) && !wasPaidBy(i)).reduce((s, i) => s + netOf(i), 0);
  const paidTotal = invoices.filter((i) => wasPaidBy(i)).reduce((s, i) => s + netOf(i), 0);
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
              linesOf(b.lines).map((ln) =>
                b.lines[ln] > 0 ? (
                  <div className="bn-bd" key={ln} style={bnVars({ "--c": lineColor(ln) })}>
                    <span className="bn-bd-name"><i />{lineLabel(ln)}</span>
                    <span className="bn-bd-calc">
                      {b.lines[ln].toFixed(2)}{u} × {rateOf(b, ln).toLocaleString()} €
                    </span>
                    <span className="bn-bd-val">
                      {eur(b.lines[ln] * rateOf(b, ln))} €
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
              <span className="bn-lline" style={bnVars({ "--c": lineColor(r.line) })}>{lineLabel(r.line)}</span>
              <span className={`bn-lstatus is-${r.status}`}>{r.status}</span>
              <span className="bn-r bn-lnum">{r.days.toFixed(2)}{u}</span>
              <span className="bn-r bn-lnum">
                {eur(r.days * rateOf(b, r.line))} €
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
            <small className="bn-kpi-sub">
              {outstandingCount} {outstandingCount === 1 ? "invoice" : "invoices"} ready to send · excl. VAT
              {outstandingVat > 0.005 && <span className="bn-vat-note"> (+{eur(outstandingVat)} € VAT)</span>}
            </small>
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
                  <button type="button" className="bn-xlsx is-go" disabled={selected.size === 0 || exporting} onClick={() => exportSelected()}
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
          <PageLoader fill={false} size={96} label="Loading invoices" />
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
                const totalDays = sumLines(b.lines);
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
                        <ClientLogo className="bn-av mg-logo" name={clientNames[b.clientId] || b.legalName || "?"} clientId={b.clientId} />
                        <span className="bn-who-t">
                          <span className="bn-name">
                            <b>{b.legalName}</b>
                            <span className="bn-ptag">{periodLabel(b.period)}</span>
                            {adjustedBills[`${b.projectId}|${b.period}`] && (
                              <span className="bn-modtag" title={`Modified · v${adjustedBills[`${b.projectId}|${b.period}`]}`}>
                                <i /> modified
                              </span>
                            )}
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
                      <span className="bn-num is-amt">
                        <b>{eur(net(b))} €</b>
                        {b.taxed && b.taxRate > 0 && <small className="bn-amt-vat">{eur(gross(b))} € incl. VAT</small>}
                      </span>
                      <span className="bn-chev"><BnIcon d={BN_ICON.chev} w={2.4} /></span>
                    </button>
                    {isOpen && (
                      <div className="bn-detail">
                        {billComposition(b)}
                        <div className="bn-dactions">
                          <span>Marking as sent records this invoice for {periodLabel(b.period)} and moves it to Sent.</span>
                          <button type="button" className="bn-adjust" onClick={() => setAdjusting({ bill: b, invoice: null })}>
                            <BnIcon d={BN_ICON.tune} w={2.2} /> Adjust calculation
                          </button>
                          <button type="button" className="bn-send" disabled={busy === b.key} onClick={() => setSendAsk({ bill: b, downloaded: false })}>
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
                  const liveDays = comp ? +sumLines(comp.lines).toFixed(2) : inv.days;
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
                          <ClientLogo className="bn-av mg-logo" name={projName(inv.projectId)} clientId={projects[inv.projectId]?.clientId} />
                          <span className="bn-who-t">
                            <span className="bn-name"><b>{projName(inv.projectId)}</b></span>
                            <span className="bn-meta">
                              <span className="bn-ptag">{periodLabel(inv.period)}</span>
                              <span>{inv.days.toFixed(2)}{u}</span>
                              {adjustedBills[`${inv.projectId}|${inv.period}`] && (
                                <span className="bn-modtag" title={`Modified · v${adjustedBills[`${inv.projectId}|${inv.period}`]}`}>
                                  <i /> modified
                                </span>
                              )}
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
                          <b>{eur(netOf(inv))} €</b>
                          {inv.amount - netOf(inv) > 0.005 && <small className="bn-amt-vat">{eur(inv.amount)} € incl. VAT</small>}
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
                          <button type="button" className="bn-act is-ghost bn-act-pdf" title={inv.number ? `Invoice ${inv.number} as a PDF` : "Make the PDF invoice"}
                            onClick={(e) => { e.stopPropagation(); setInvoicing({ doc: docFromBill(comp ?? null, inv), title: projName(inv.projectId), invoiceId: inv.id }); }}>
                            <BnIcon d={BN_ICON.out} w={2.1} />{inv.number || "PDF"}
                          </button>
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
                      {isOpen && comp && (
                        <div className="bn-detail">
                          {billComposition(comp, inv)}
                          <div className="bn-dactions">
                            <button type="button" className="bn-adjust" onClick={() => setAdjusting({ bill: comp, invoice: inv })}>
                              <BnIcon d={BN_ICON.tune} w={2.2} /> Adjust calculation
                            </button>
                          </div>
                        </div>
                      )}
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
                          {a.billable.toFixed(2)}{a.project_id ? unitOf(a.project_id) : "d"} {lineLabel(a.billing_line ?? "consultor").toLowerCase()}, dated {bnDate(a.entry_date)}, would fall in {periodLabel(a.period)}
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
        const rateOfLine = (line: Line) => rateOf(b, line);

        const num = (v: string) => (v === "" || isNaN(Number(v)) ? 0 : Number(v));
        const invalid = fixing.cells.some((c) => c.days !== "" && isNaN(Number(c.days)));

        // Totals per line and grand totals.
        const lineTotal = (line: Line) => fixing.cells.filter((c) => c.line === line).reduce((s2, c) => s2 + num(c.days), 0);
        // Group cells by line (role), in catalogue order, for rendering.
        const lines: Line[] = fixing.cells.map((c) => c.line)
          .filter((l, i, a) => a.indexOf(l) === i)
          .sort((x, y) => lineOrder(x) - lineOrder(y));
        const totals: Lines = Object.fromEntries(lines.map((l) => [l, lineTotal(l)]));
        const newNet = lines.reduce((s2, l) => s2 + totals[l] * rateOfLine(l), 0);
        const newAmount = newNet * (b.taxed ? 1 + b.taxRate / 100 : 1);
        const newDays = +sumLines(totals).toFixed(2);
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
                    <div className="bn-fix-group" key={line} style={bnVars({ "--c": lineColor(line) })}>
                      <div className="bn-fix-ghead">
                        <span><i />{lineLabel(line)}</span>
                        <span className="bn-fix-grate">{rateOfLine(line).toLocaleString()} €/{u}</span>
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
                Reset to entries ({(+sumLines(b.lines).toFixed(2))}{u})
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
                    await recomputeInvoice(fixing.inv, b, totals);
                    setFixing(null);
                  }}>
                  Save invoice
                </button>
              </footer>
            </div>
          </div>
        );
      })()}

      {sendAsk && (() => {
        const b = sendAsk.bill;
        // If this bill is part of a ticked selection, the report covers the whole selection.
        const group = selected.has(b.key) ? outstanding.filter((x) => selected.has(x.key)) : [b];
        const close = () => setSendAsk(null);
        return (
          <div className="bn-pop-backdrop" onMouseDown={close}>
            <div className="bn-pop is-ask" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Confirm sending">
              <header className="bn-pop-head">
                <span className="bn-pop-ico is-warn"><BnIcon d={BN_ICON.xls} w={2} /></span>
                <div>
                  <h3>Have you downloaded the billing report?</h3>
                  <small>Download the Excel first. Once sent, it leaves To bill.</small>
                </div>
              </header>
              <div className="bn-ask-body">
                <div className="bn-ask-bill">
                  <ClientLogo clientId={b.clientId} name={clientNames[b.clientId] || b.legalName} className="bn-av mg-logo bn-ask-logo" />
                  <div className="bn-ask-txt">
                    <b>{b.legalName || clientNames[b.clientId]}</b>
                    <small>{periodLabel(b.period)} · {(+sumLines(b.lines).toFixed(2))}{unitOf(b.projectId)}</small>
                  </div>
                  <span className="bn-ask-amt">{eur(net(b))} €</span>
                </div>
                <button type="button" className={`bn-ask-dl${sendAsk.downloaded ? " is-done" : ""}`} disabled={exporting}
                  onClick={async () => { await exportSelected(group); setSendAsk((a) => a && { ...a, downloaded: true }); }}>
                  <span className="bn-ask-dl-ico"><BnIcon d={sendAsk.downloaded ? BN_ICON.paid : BN_ICON.xls} w={2.2} /></span>
                  <span className="bn-ask-dl-txt">
                    <b>{exporting ? "Preparing…" : sendAsk.downloaded ? "Report downloaded" : "Download report"}</b>
                    <small>{group.length > 1 ? `Excel with the ${group.length} selected bills` : "Excel for this bill"}</small>
                  </span>
                </button>
                <button type="button" className={`bn-ask-dl is-inv${invMeta[b.key] ? " is-done" : ""}`}
                  onClick={() => setInvoicing({ doc: docFromBill(b), title: b.legalName || clientNames[b.clientId] || "Client", billKey: b.key })}>
                  <span className="bn-ask-dl-ico"><BnIcon d={invMeta[b.key] ? BN_ICON.paid : BN_ICON.out} w={2.2} /></span>
                  <span className="bn-ask-dl-txt">
                    <b>{invMeta[b.key] ? `Invoice ${invMeta[b.key].number} ready` : "Invoice for the client"}</b>
                    <small>{invMeta[b.key] ? "PDF downloaded — open it again to change it" : "Build the PDF invoice, with its number, to send"}</small>
                  </span>
                </button>
              </div>
              <footer className="bn-pop-foot">
                <button type="button" className="bn-act is-ghost" onClick={close}>Cancel</button>
                <button type="button" className="bn-act is-pay" disabled={busy === b.key}
                  onClick={async () => { close(); await markSent(b); }}>
                  Yes, send <BnIcon d={BN_ICON.sent} w={2.2} />
                </button>
              </footer>
            </div>
          </div>
        );
      })()}

      {invoicing && (
        <InvoiceModal doc0={invoicing.doc} used={usedNumbers} title={invoicing.title} onClose={() => setInvoicing(null)}
          onDone={(m) => {
            if (invoicing.invoiceId) void keepNumber(invoicing.invoiceId, m);
            else if (invoicing.billKey) setInvMeta((x) => ({ ...x, [invoicing.billKey!]: m }));
          }} />
      )}

      {adjusting && (
        <BillingAdjustModal
          bill={adjusting.bill}
          invoice={adjusting.invoice}
          unit={unitOf(adjusting.bill.projectId)}
          clientName={clientNames[adjusting.bill.clientId] ?? adjusting.bill.legalName ?? "Client"}
          people={people}
          periodLabel={periodLabel(adjusting.bill.period)}
          roles={roles}
          onClose={() => setAdjusting(null)}
          onSave={saveAdjustment}
        />
      )}
    </div>
  );
}