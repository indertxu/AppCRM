/* =====================================================================
   Contracts of one client grouped under a main one (136_contract_groups.sql).
   Each contract keeps its own dates and figures; the group reads as one.
   A contract's key: "t:<deal id>" (a deal's contract, or the products signed
   on that deal), or "l:<client id>|none" (products signed by hand).
   ===================================================================== */
import { supabase } from "../../../components/api/supabase";

export interface ContractGroupRow { main_key: string; member_key: string; client_id: string | null }
export const NEEDS_GROUPS = "Grouping contracts needs 136_contract_groups.sql in Supabase.";
const missing = (m: string) => /contract_groups|relation|schema cache|does not exist/i.test(m);

/** Every contract that sits inside another: member → main. Empty when the table isn't there yet. */
export async function loadContractGroups(): Promise<ContractGroupRow[]> {
  const { data, error } = await supabase.from("contract_groups").select("main_key, member_key, client_id");
  if (error) return [];
  return (data ?? []) as ContractGroupRow[];
}

/** Puts `keys` together under `main` (any groups they were in are folded into this one). */
export async function groupContracts(clientId: string | null, main: string, keys: string[]): Promise<string | null> {
  const all = [...new Set([main, ...keys])];
  // what these contracts were grouped with before: those come along
  const { data: old, error: e0 } = await supabase.from("contract_groups").select("main_key, member_key").or(`main_key.in.(${all.map(q).join(",")}),member_key.in.(${all.map(q).join(",")})`);
  if (e0) return missing(e0.message) ? NEEDS_GROUPS : e0.message;
  const members = new Set(all);
  ((old ?? []) as ContractGroupRow[]).forEach((r) => { members.add(r.main_key); members.add(r.member_key); });
  const mains = [...new Set(((old ?? []) as ContractGroupRow[]).map((r) => r.main_key))];
  if (mains.length) {
    const { error } = await supabase.from("contract_groups").delete().in("main_key", mains);
    if (error) return error.message;
  }
  const { error: e1 } = await supabase.from("contract_groups").delete().in("member_key", [...members]);
  if (e1) return e1.message;
  members.delete(main);
  if (!members.size) return null;
  const { error } = await supabase.from("contract_groups").insert([...members].map((k) => ({ client_id: clientId, main_key: main, member_key: k })));
  return error ? (missing(error.message) ? NEEDS_GROUPS : error.message) : null;
}

/** Every contract of the group back on its own. */
export async function ungroupContracts(main: string): Promise<string | null> {
  const { error } = await supabase.from("contract_groups").delete().eq("main_key", main);
  return error?.message ?? null;
}

/** One contract out of its group (the rest stay together while two or more are left). */
export async function takeOutOfGroup(main: string, member: string): Promise<string | null> {
  const { error } = await supabase.from("contract_groups").delete().eq("main_key", main).eq("member_key", member);
  return error?.message ?? null;
}

/** Another contract of the group becomes the main one. */
export async function setGroupMain(clientId: string | null, oldMain: string, newMain: string, keys: string[]): Promise<string | null> {
  const e = await ungroupContracts(oldMain);
  return e ?? groupContracts(clientId, newMain, keys);
}

/** A value inside a PostgREST in.(…) list. */
const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;

/** The contracts a client already has, to put a new one in (when a deal is closed): one option per contract on its
 *  own, and one per group (its main contract's key — the new one joins that group). `skip`: the deal being closed. */
export async function clientContractOptions(clientId: string, skip?: string | null): Promise<{ value: string; label: string; hint: string }[]> {
  const [{ data: lines }, groups] = await Promise.all([
    supabase.from("client_products").select("*").eq("client_id", clientId),
    loadContractGroups(),
  ]);
  const ls = (lines ?? []) as any[];
  const keyOf = (l: any) => (l.contract_tracking_id || l.tracking_id ? `t:${l.contract_tracking_id || l.tracking_id}` : l.source_invoice_id ? `l:${clientId}|inv:${l.source_invoice_id}` : `l:${clientId}|none`);
  const byKey = new Map<string, { signed: string; n: number }>();
  ls.forEach((l) => {
    const k = keyOf(l);
    const x = byKey.get(k) ?? { signed: "", n: 0 };
    const d = String(l.signing_date || l.start_date || "").slice(0, 10);
    byKey.set(k, { signed: !x.signed || (d && d < x.signed) ? d : x.signed, n: x.n + 1 });
  });
  // deal contracts (tracking_contracts) on this client's won deals that have no signed products here
  const { data: cl } = await supabase.from("clients").select("company_id").eq("id", clientId).maybeSingle();
  const coId = (cl as any)?.company_id ?? null;
  if (coId) {
    const { data: ts } = await supabase.from("trackings").select("id").eq("company_id", coId).eq("status", "won");
    const tids = ((ts ?? []) as any[]).map((t) => t.id);
    if (tids.length) {
      const { data: tc } = await supabase.from("tracking_contracts").select("tracking_id, data, active").in("tracking_id", tids);
      ((tc ?? []) as any[]).filter((r) => r.active !== false).forEach((r) => {
        const k = `t:${r.tracking_id}`;
        if (!byKey.has(k)) byKey.set(k, { signed: String(r.data?.signed || r.data?.start || "").slice(0, 10), n: (r.data?.items ?? []).length });
      });
    }
  }
  if (skip) byKey.delete(`t:${skip}`);
  const tids = [...byKey.keys()].filter((k) => k.startsWith("t:")).map((k) => k.slice(2));
  const names = new Map<string, string>();
  if (tids.length) {
    const { data } = await supabase.from("trackings").select("id, deal_name, contract_terms").in("id", tids);
    ((data ?? []) as any[]).forEach((t) => names.set(`t:${t.id}`, t.contract_terms?.contractRef ? `Contract No. ${t.contract_terms.contractRef}` : t.deal_name ? `Contract · ${t.deal_name}` : "Contract"));
  }
  const invRef = new Map(ls.filter((l) => l.source_invoice_id).map((l) => [`l:${clientId}|inv:${l.source_invoice_id}`, String(l.contract_ref ?? "")]));
  const nameOf = (k: string) => names.get(k) ?? (invRef.has(k) ? `Contract · invoice ${invRef.get(k)}`.trim() : k.startsWith("l:") ? "Signed products" : "Contract");
  const day = (d: string) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");
  const memberOf = new Map(groups.map((g) => [g.member_key, g.main_key]));
  const out: { value: string; label: string; hint: string }[] = [];
  const seenMain = new Set<string>();
  [...byKey.entries()].sort((a, b) => a[1].signed.localeCompare(b[1].signed)).forEach(([k, x]) => {
    const main = memberOf.get(k) ?? (groups.some((g) => g.main_key === k) ? k : null);
    if (main) {
      if (seenMain.has(main)) return;
      seenMain.add(main);
      const n = 1 + groups.filter((g) => g.main_key === main).length;
      out.push({ value: main, label: `${nameOf(main)} · group of ${n}`, hint: "Joins this group" });
    } else {
      out.push({ value: k, label: nameOf(k), hint: x.signed ? `Signed ${day(x.signed)}` : "" });
    }
  });
  return out;
}
