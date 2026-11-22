"use client";

import { ReactNode, createContext, useContext, useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { clearAllDrafts } from "@/lib/useFormDraft";

type SupabaseContextValue = {
  supabase: typeof supabase;
  user: User | null;
  isLoading: boolean;
};

const SupabaseContext = createContext<SupabaseContextValue | undefined>(
  undefined
);

export function SupabaseProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    const init = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!mounted) return;
      setUser((prev) => (prev && user && prev.id === user.id ? prev : user ?? null));
      setIsLoading(false);
    };

    init();

    const {
      data: subscription,
    } = supabase.auth.onAuthStateChange((event, session) => {
      const next = session?.user ?? null;
      if (event === "SIGNED_OUT" || !next) clearAllDrafts();
      // Supabase repeats SIGNED_IN / TOKEN_REFRESHED / INITIAL_SESSION when a
      // tab regains focus. For the same person, keep the existing user object
      // so pages and forms that depend on it don't reload and lose what was
      // typed. A different user (or signing out) still updates as before.
      setUser((prev) => (prev && next && prev.id === next.id ? prev : next));
    });

    return () => {
      mounted = false;
      subscription?.subscription.unsubscribe();
    };
  }, []);

  return (
    <SupabaseContext.Provider value={{ supabase, user, isLoading }}>
      {children}
    </SupabaseContext.Provider>
  );
}

export function useSupabase() {
  const ctx = useContext(SupabaseContext);
  if (!ctx) {
    throw new Error("useSupabase must be used within SupabaseProvider");
  }
  return ctx;
}


