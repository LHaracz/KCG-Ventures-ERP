"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { loadProductFormula, type BotanicalProduct, type FormulaSnapshot, type ProductFormula } from "@/lib/sopFormulaData";

/**
 * Rendering context for SOP documents.
 * - mode "live": formula tables read the product's latest final formulation (editor).
 * - mode "snapshot": formula tables read the version's frozen formula_snapshot (viewer).
 */
type Ctx = {
  mode: "live" | "snapshot";
  snapshot: FormulaSnapshot | null;
  products: BotanicalProduct[];
  defaultProductId: string | null;
  getLive: (productId: string) => LiveState;
  requestLive: (productId: string) => void;
  refreshLive: () => void;
  imageUrl: (path: string) => string | null;
  requestImage: (path: string) => void;
  selectedFormulaNodeId: string | null;
  setSelectedFormulaNodeId: (id: string | null) => void;
};

export type LiveState = { loading: boolean; error: string | null; data: ProductFormula | null };

const SopRenderCtx = createContext<Ctx | null>(null);

export function useSopRender(): Ctx {
  const ctx = useContext(SopRenderCtx);
  if (!ctx) throw new Error("useSopRender must be used inside SopRenderProvider");
  return ctx;
}

export function SopRenderProvider({
  mode,
  snapshot,
  products,
  defaultProductId,
  supabase,
  getToken,
  children,
}: {
  mode: "live" | "snapshot";
  snapshot?: FormulaSnapshot | null;
  products: BotanicalProduct[];
  defaultProductId?: string | null;
  supabase: any;
  getToken: () => Promise<string>;
  children: ReactNode;
}) {
  const [live, setLive] = useState<Record<string, LiveState>>({});
  const inflight = useRef(new Set<string>());
  const [images, setImages] = useState<Record<string, string>>({});
  const pendingImages = useRef(new Set<string>());
  const imageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selectedFormulaNodeId, setSelectedFormulaNodeId] = useState<string | null>(null);

  const requestLive = useCallback(
    (productId: string) => {
      if (!productId || inflight.current.has(productId)) return;
      inflight.current.add(productId);
      setLive((s) => ({ ...s, [productId]: { loading: true, error: null, data: s[productId]?.data ?? null } }));
      loadProductFormula(supabase, productId)
        .then((data) => setLive((s) => ({ ...s, [productId]: { loading: false, error: null, data } })))
        .catch((err: unknown) =>
          setLive((s) => ({
            ...s,
            [productId]: { loading: false, error: err instanceof Error ? err.message : "Failed to load formula.", data: null },
          })),
        )
        .finally(() => inflight.current.delete(productId));
    },
    [supabase],
  );

  const refreshLive = useCallback(() => {
    const ids = Object.keys(live);
    ids.forEach((id) => requestLive(id));
  }, [live, requestLive]);

  const getLive = useCallback((productId: string): LiveState => live[productId] ?? { loading: true, error: null, data: null }, [live]);

  const flushImages = useCallback(async () => {
    const paths = Array.from(pendingImages.current);
    pendingImages.current.clear();
    if (!paths.length) return;
    try {
      const token = await getToken();
      const res = await fetch("/api/compliance/sops/images/signed-urls", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ paths }),
      });
      const payload = await res.json();
      if (res.ok) setImages((s) => ({ ...s, ...(payload.urls ?? {}) }));
    } catch {
      // Images just stay as placeholders.
    }
  }, [getToken]);

  const requestImage = useCallback(
    (path: string) => {
      if (!path || images[path] || pendingImages.current.has(path)) return;
      pendingImages.current.add(path);
      if (imageTimer.current) clearTimeout(imageTimer.current);
      imageTimer.current = setTimeout(flushImages, 30);
    },
    [images, flushImages],
  );

  // Signed URLs expire after 10 minutes; refresh every 8 minutes while the page is open.
  useEffect(() => {
    const t = setInterval(() => {
      const paths = Object.keys(images);
      if (!paths.length) return;
      paths.forEach((p) => pendingImages.current.add(p));
      flushImages();
    }, 8 * 60 * 1000);
    return () => clearInterval(t);
  }, [images, flushImages]);

  const value = useMemo<Ctx>(
    () => ({
      mode,
      snapshot: snapshot ?? null,
      products,
      defaultProductId: defaultProductId ?? null,
      getLive,
      requestLive,
      refreshLive,
      imageUrl: (p) => images[p] ?? null,
      requestImage,
      selectedFormulaNodeId,
      setSelectedFormulaNodeId,
    }),
    [mode, snapshot, products, defaultProductId, getLive, requestLive, refreshLive, images, requestImage, selectedFormulaNodeId],
  );

  return <SopRenderCtx.Provider value={value}>{children}</SopRenderCtx.Provider>;
}
