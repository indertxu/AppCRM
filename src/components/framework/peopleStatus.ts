import { useEffect, useState } from "react";
import { supabase } from "../api/supabase";

/**
 * Former employees (laid off in Settings → Organization).
 * They keep their name on everything they did — deals, hours, history — but
 * must not be offered as an option anywhere: filters, owners, teams, pickers.
 *
 * Usage:  const inactive = useInactiveIds();
 *         options = people.filter((p) => !inactive.has(p.id) || alreadyChosen.includes(p.id))
 */
let cache: Promise<Set<string>> | null = null;
const listeners = new Set<(s: Set<string>) => void>();

export function loadInactiveIds(force = false): Promise<Set<string>> {
  if (!cache || force) {
    cache = (async () => {
      const { data, error } = await supabase.from("profiles").select("id").eq("active", false);
      if (error) return new Set<string>(); // column not created yet → nobody is inactive
      return new Set<string>(((data ?? []) as { id: string }[]).map((r) => r.id));
    })();
    cache.then((s) => listeners.forEach((fn) => fn(s)));
  }
  return cache;
}

/** Only the people still working here (the ones to offer in a picker or a filter). */
export const stillHere = <T extends { id: string }>(xs: T[], inactive: Set<string>): T[] => (inactive.size ? xs.filter((x) => !inactive.has(x.id)) : xs);
/** The same, read straight away (for code outside components). */
export async function withoutFormer<T extends { id: string }>(xs: T[]): Promise<T[]> { return stillHere(xs, await loadInactiveIds()); }

/** Call after laying someone off / reactivating, so every open page updates. */
export const refreshInactiveIds = () => loadInactiveIds(true);

export function useInactiveIds(): Set<string> {
  const [ids, setIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    loadInactiveIds().then((s) => alive && setIds(s));
    const fn = (s: Set<string>) => alive && setIds(s);
    listeners.add(fn);
    return () => { alive = false; listeners.delete(fn); };
  }, []);
  return ids;
}