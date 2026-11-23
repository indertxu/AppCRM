/* =====================================================================
   ENTERPRISE · Billing › Workflows — the few shapes the workflow screens
   need from Billing (in Base they come from its billingApi.ts).
   ===================================================================== */

/** A client the workflows can address: its billing e-mail and website (for the logo). */
export interface BClient { id: string; name: string; email: string; website: string }
/** An invoice as the workflow screens show it (activity, routing). */
export interface Invoice { id: string; client_id: string | null; number: string; amount: number }

const eur = new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR", maximumFractionDigits: 2, minimumFractionDigits: 2 });
export const money = (n: number) => eur.format(Number(n) || 0);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const fmtDate = (s: string | null | undefined) => {
  if (!s) return "—";
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return `${d} ${MON[m - 1]} ${y}`;
};
