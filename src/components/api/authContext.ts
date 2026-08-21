import { createContext, useContext } from "react";
import type { Session } from "@supabase/supabase-js";

export type Role = "consultant" | "admin" | "boss";

export interface AuthContextValue {
  session: Session | null;
  role: Role | null;
  isSuperadmin: boolean;
  loading: boolean; // session resolved
  roleLoading: boolean; // profile role resolved
}

export const AuthContext = createContext<AuthContextValue>({
  session: null,
  role: null,
  isSuperadmin: false,
  loading: true,
  roleLoading: true,
});

export function useAuth() {
  return useContext(AuthContext);
}