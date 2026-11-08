"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import type { FeatureKey, Sidebar } from "@/lib/access/catalog";

/**
 * What the signed-in employee may use, for showing and hiding UI (sidebar,
 * links, buttons). It is refreshed from the server on every navigation. It
 * never grants anything: pages, API routes and the database check access
 * themselves.
 */
export type Me = {
  active: boolean;
  status: string | null;
  isAdmin: boolean;
  features: string[];
  roles: string[];
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  accountId: string | null;
  sidebar: Sidebar;
};

type Ctx = {
  me: Me | null;
  loading: boolean;
  has: (key: FeatureKey) => boolean;
  hasAny: (keys: readonly FeatureKey[]) => boolean;
  refresh: () => Promise<void>;
};

const AccessContext = createContext<Ctx>({
  me: null,
  loading: true,
  has: () => false,
  hasAny: () => false,
  refresh: async () => {},
});

export function AccessProvider({ initial, children }: { initial: Me | null; children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(initial);
  const [loading, setLoading] = useState(initial === null);
  const pathname = usePathname();
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const n = ++seq.current;
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) {
        if (n === seq.current) setMe(null);
        return;
      }
      const res = await fetch("/api/account/me", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      const body = res.ok ? ((await res.json()) as Me) : null;
      if (n === seq.current) setMe(body);
    } catch {
      if (n === seq.current) setMe(null); // fail closed
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Re-read on every navigation so role changes show without a full reload.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-navigate; state is set after the request resolves
    void refresh();
  }, [pathname, refresh]);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange(() => void refresh());
    return () => data.subscription.unsubscribe();
  }, [refresh]);

  const value = useMemo<Ctx>(() => {
    const set = new Set(me?.features ?? []);
    const has = (k: FeatureKey) => !!me?.active && (me.isAdmin || set.has(k));
    return { me, loading, has, hasAny: (keys) => keys.some(has), refresh };
  }, [me, loading, refresh]);

  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}

export const useAccess = () => useContext(AccessContext);
