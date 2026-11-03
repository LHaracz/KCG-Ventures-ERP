"use client";

/**
 * Client helpers for the Pick List and Shipping Assignments pages:
 *  - useAuthedApi(): JSON fetch with the Supabase session's bearer token
 *    (the same auth the existing fulfillment pages use).
 *  - useWarehouseData(): polls /api/fulfillments/warehouse about every 15
 *    seconds and when the window regains focus. The server only goes to
 *    Shopify at most once a minute (orders cache), so polling never causes
 *    Shopify rate limits.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSupabase } from "@/components/InstantProvider";
import type { WarehouseSnapshot } from "@/lib/warehouse";
import type { LoaderMeta } from "@/lib/fulfillmentOrdersLoader";

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string | null, public readonly body: any) {
    super(message);
  }
}

export function useAuthedApi() {
  const { supabase } = useSupabase();
  return useCallback(
    async <T = any,>(path: string, init?: { method?: string; body?: unknown }): Promise<T> => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new ApiError("Unable to verify your session.", 401, null, null);
      const response = await fetch(path, {
        method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new ApiError(payload.error || "Request failed.", response.status, payload.code ?? null, payload);
      }
      return payload as T;
    },
    [supabase],
  );
}

export type WarehouseData = WarehouseSnapshot & { meta: LoaderMeta; serverTime: string };

export const WAREHOUSE_POLL_MS = 15_000;

export function useWarehouseData() {
  const { user } = useSupabase();
  const api = useAuthedApi();
  const [data, setData] = useState<WarehouseData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await api<WarehouseData>("/api/fulfillments/warehouse");
      setData(next);
      setError(null);
    } catch (err: any) {
      setError(err?.message || "Failed to load orders.");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (!user) return;
    refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, WAREHOUSE_POLL_MS);
    const onFocus = () => refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [user, refresh]);

  return { data, loading, error, refresh };
}
