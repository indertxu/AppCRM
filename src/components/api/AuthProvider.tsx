import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

export type Role = "consultant" | "admin" | "boss";

interface AuthContextValue {
  session: Session | null;
  role: Role | null;
  loading: boolean; // session resolved
  roleLoading: boolean; // profile role resolved
}

const AuthContext = createContext<AuthContextValue>({
  session: null,
  role: null,
  loading: true,
  roleLoading: true,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);
  const [roleLoading, setRoleLoading] = useState(true);

  // Track the session
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Load the profile role whenever the user changes
  // (kept out of the auth callback to avoid Supabase's auth-lock deadlock)
  useEffect(() => {
    let active = true;
    const uid = session?.user?.id;

    if (!uid) {
      setRole(null);
      setRoleLoading(false);
      return;
    }

    setRoleLoading(true);
    supabase
      .from("profiles")
      .select("role")
      .eq("id", uid)
      .single()
      .then(({ data }) => {
        if (!active) return;
        setRole((data?.role as Role) ?? null);
        setRoleLoading(false);
      });

    return () => {
      active = false;
    };
  }, [session?.user?.id]);

  return (
    <AuthContext.Provider value={{ session, role, loading, roleLoading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}