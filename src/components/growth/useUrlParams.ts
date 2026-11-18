"use client";

/**
 * Tab filters kept in the URL, so switching tabs (or coming back from an
 * editor) keeps them. Each tab uses its own prefix (lib_, pil_, as_, cal_).
 */
import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export function useUrlParams() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const get = useCallback((k: string, d = "") => sp.get(k) ?? d, [sp]);
  const set = useCallback(
    (patch: Record<string, string | null | undefined>) => {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined || v === "") next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [sp, router, pathname],
  );
  return { get, set, query: sp.toString() };
}

/** A comma-separated list in one URL parameter. */
export const listParam = (v: string) => (v ? v.split(",").filter(Boolean) : []);
