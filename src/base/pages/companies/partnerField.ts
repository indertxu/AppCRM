import { useEffect, useState } from "react";
import { partnerList } from "./companiesApi";

/** A dropdown field called "…partner…" lists the partners (companies with a partner type), not its own options. */
export const isPartnerField = (f: { label: string; type: string }) => /partner/i.test(f.label) && (f.type === "select" || f.type === "multiselect");
/** The partners' names, for such a field (read once per visit). */
export function usePartnerNames(on: boolean): string[] | null {
  const [names, setNames] = useState<string[] | null>(null);
  useEffect(() => {
    if (!on) return;
    let off = false;
    partnerList().then((r) => { if (!off) setNames(r.map((x) => x.name)); }).catch(() => {});
    return () => { off = true; };
  }, [on]);
  return on ? names : null;
}
