import { createContext, useContext } from "react";
import type { Session } from "@supabase/supabase-js";

export type Role = "consultant" | "admin" | "boss";
/** Which app the company's users get (tenants.plan): the full Enterprise app or the simple Base app. */
export type Plan = "enterprise" | "base";

export interface AuthContextValue {
  session: Session | null;
  role: Role | null;
  isSuperadmin: boolean;
  /** the company's tier (tenants.plan, read with my_plan()); resolved together with the role */
  plan: Plan;
  loading: boolean; // session resolved
  roleLoading: boolean; // profile role resolved
}

export const AuthContext = createContext<AuthContextValue>({
  session: null,
  role: null,
  isSuperadmin: false,
  plan: "enterprise",
  loading: true,
  roleLoading: true,
});

export function useAuth() {
  return useContext(AuthContext);
}