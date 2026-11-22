/* =====================================================================
   BASE · Billing › Workflows — small shared pieces (icons, marks, chips,
   the blueprint thumbnail) used by the page and its guided editors.
   ===================================================================== */
import { useState } from "react";
import type { MailAcct } from "../../../../components/api/marketingHub";
import ClientLogo from "../ClientLogo";
import { fmtDate } from "../billingApi";
import { MAIL_VARS, type Entity, type FlowTrigger, type PdfDesign } from "./flowsApi";

export const Ico = ({ d, s = 16 }: { d: string; s?: number }) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
export const I = {
  flow: "M5 3v6M5 15v6M5 9a3 3 0 0 0 3 3h8a3 3 0 0 1 3 3v6M19 3v6",
  doc: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5",
  building: "M3 21h18M5 21V7l7-4 7 4v14M9 9h1M14 9h1M9 13h1M14 13h1M9 17h1M14 17h1",
  plus: "M12 5v14M5 12h14",
  cal: "M7 3v3M17 3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4z",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
  alert: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  users: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  mail: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6",
  up: "M18 15l-6-6-6 6", down: "M6 9l6 6 6-6", right: "M9 18l6-6-6-6",
  eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  play: "M5 3l14 9-14 9z", trash: "M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6",
  star: "M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z",
  check: "M20 6 9 17l-5-5", x: "M18 6 6 18M6 6l12 12", download: "M12 3v12M7 10l5 5 5-5M5 21h14",
  left: "M15 18l-6-6 6-6", edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z", pin: "M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11zM12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  card: "M2 6h20v12H2zM2 10h20M6 15h4", brush: "M9.1 14.9a3 3 0 0 0-4.2 0C3.7 16 4 18.5 2 20c3 .9 6.3.6 7.6-.9a3 3 0 0 0-.5-4.2zM9 15l11.6-11.6a1.4 1.4 0 0 0-2-2L7 13",
  spark: "M12 3l1.8 4.6L18.5 9l-4.7 1.6L12 15l-1.8-4.4L5.5 9l4.7-1.4z", info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z",
  text: "M4 6h16M4 12h10M4 18h7", layout: "M3 3h18v18H3zM3 9h18M9 21V9",
};
export const TRIG_ICON: Record<FlowTrigger, string> = { billing_day: I.cal, issued: I.send, before_due: I.bell, overdue: I.alert };
export const TRIG_HINT: Record<FlowTrigger, string> = {
  billing_day: "The invoices the monthly cutoff makes go out to each client",
  issued: "Any invoice, by hand or automatic, once it's marked sent",
  before_due: "A friendly reminder while it's still unpaid",
  overdue: "A reminder when the due date has passed and it isn't paid",
};
export const ACCENTS = ["#0a6f4d", "#12a374", "#1f6feb", "#2f4bd8", "#6d3bd8", "#b42363", "#d9480f", "#0f172a"];
export const ago = (s: string | null) => {
  if (!s) return "never";
  const m = Math.round((Date.now() - new Date(s).getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : fmtDate(s.slice(0, 10));
};
export const acctLabel = (a: MailAcct) => `${a.email}${a.kind === "ionos" ? " · SMTP" : a.kind === "gmail" ? " · Gmail" : " · Outlook"}`;

export function EntMark({ e, big }: { e: Pick<Entity, "name" | "legal_name" | "logo_url" | "website" | "color">; big?: boolean }) {
  const [bad, setBad] = useState(false);
  const n = e.name || e.legal_name || "?";
  if (e.logo_url && !bad) return <span className={`bf-em ${big ? "is-big" : ""} has-img`}><img src={e.logo_url} alt="" onError={() => setBad(true)} /></span>;
  if (e.website) return <span className={`bf-em ${big ? "is-big" : ""} is-site`}><ClientLogo name={n} website={e.website} size={big ? 40 : 20} /></span>;
  return <span className={`bf-em ${big ? "is-big" : ""}`} style={{ background: e.color || "#0a6f4d" }}>{n.trim()[0]?.toUpperCase() ?? "?"}</span>;
}

/** {{fields}} as chips. */
export function Vars({ t }: { t: string }) {
  const parts = String(t ?? "").split(/(\{\{\s*[a-z_]+\s*\}\})/gi);
  return <>{parts.map((p, i) => { const k = /^\{\{\s*([a-z_]+)\s*\}\}$/i.exec(p)?.[1]?.toLowerCase(); const v = k && MAIL_VARS.find((m) => m.key === k); return v ? <span key={i} className="bf-var">{v.label}</span> : p.split("\n").map((x, j) => <span key={`${i}.${j}`}>{j > 0 && <br />}{x}</span>); })}</>;
}

export function BpThumb({ d, ent }: { d: PdfDesign; ent: Entity | null }) {
  return (
    <span className={`bf-thumb is-${d.layout}`} style={{ ["--ac" as string]: d.accent || "#0a6f4d" }}>
      <span className="bf-thumb-pg">
        {d.layout === "band" ? <span className="bf-th-band"><i />{ent?.logo_url ? <img src={ent.logo_url} alt="" /> : <u />}</span> : <span className="bf-th-top"><i /><u /></span>}
        <span className="bf-th-lines"><s /><s /><s /><s /></span>
        <span className="bf-th-tot"><s /><b /></span>
      </span>
    </span>
  );
}
