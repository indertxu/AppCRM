import { useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { AuthContext, type Role } from "./authContext";

// Re-export so existing files that still import from "./AuthProvider" keep working.
// Migrate them to "./authContext" over time; once none import from here, remove these.
export { useAuth } from "./authContext";
export type { Role } from "./authContext";

interface ProfileState {
  /** whose profile this is: until it matches the session's user, the role is still loading */
  uid: string | null;
  role: Role | null;
  isSuperadmin: boolean;
  roleLoading: boolean;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<ProfileState>({
    uid: null,
    role: null,
    isSuperadmin: false,
    roleLoading: true,
  });

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

  // Load the profile (role + superadmin flag) whenever the user changes.
  // All setState calls happen inside async callbacks, never synchronously in the
  // effect body — that keeps react-hooks/set-state-in-effect happy.
  useEffect(() => {
    let active = true;
    const uid = session?.user?.id;

    if (!uid) {
      queueMicrotask(() => {
        if (active) setProfile({ uid: null, role: null, isSuperadmin: false, roleLoading: false });
      });
      return () => { active = false; };
    }

    supabase
      .from("profiles")
      .select("role, is_superadmin")
      .eq("id", uid)
      .single()
      .then(({ data }) => {
        if (!active) return;
        setProfile({
          uid,
          role: (data?.role as Role) ?? null,
          isSuperadmin: !!data?.is_superadmin,
          roleLoading: false,
        });
      });

    return () => { active = false; };
  }, [session?.user?.id]);

  return (
    <AuthContext.Provider
      value={{
        session,
        role: profile.role,
        isSuperadmin: profile.isSuperadmin,
        loading,
        // a new sign-in: the old (empty) profile doesn't count — the role is loading until this user's arrives
        roleLoading: profile.roleLoading || profile.uid !== (session?.user?.id ?? null),
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}