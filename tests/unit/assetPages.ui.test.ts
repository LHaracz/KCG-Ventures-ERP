// @vitest-environment jsdom
// Assets grid: 20 per page, thumbnail links only for the page on screen and
// reused when you come back, lazy images. API calls mocked; invented data only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const api = vi.hoisted(() => ({
  signedAssetUrlsApi: vi.fn(async (...args: [ids: string[], download?: boolean, variant?: string]) => ({ urls: Object.fromEntries(args[0].map((id) => [id, `https://storage.example.test/thumb/${id}`])) })),
}));
vi.mock("@/lib/growth/client", () => ({ ...api, GrowthApiError: class extends Error {} }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/components/growth/useUrlParams", () => ({ useUrlParams: () => ({ get: (_k: string, d = "") => d, set: vi.fn(), query: "" }) }));

import { AssetsTab } from "@/components/growth/AssetLibrary";
import type { MarketingData } from "@/lib/growth/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const asset = (i: number) => ({
  id: `a${String(i).padStart(2, "0")}`,
  title: `Photo ${i}`,
  source: "upload",
  mime_type: "image/jpeg",
  file_path: `assets/2026-11/a${i}.jpg`,
  poster_path: `assets/2026-11/a${i}.jpg.poster.jpg`,
  preview_path: null,
  status: "draft",
  asset_type: "photo",
  business: "botaniqals",
  category: "market",
  url: null,
  duration_seconds: null,
  // Newest first, so Photo 1 leads.
  created_at: `2026-11-${String(30 - Math.floor(i / 2)).padStart(2, "0")}T${String(23 - (i % 2)).padStart(2, "0")}:00:00Z`,
});
const data = {
  products: [],
  ingredientTags: [],
  profiles: [],
  assetProductLinks: [],
  assetIngredientLinks: [],
  assetCategories: [{ key: "market", label: "Markets", sort_order: 40, is_builtin: true }],
  assets: Array.from({ length: 45 }, (_, i) => asset(i + 1)),
} as unknown as MarketingData;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const button = (t: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === t)!;
const cards = () => host.querySelectorAll('[data-testid="asset-card"]').length;

describe("Assets grid pages", () => {
  it("shows 20 per page and loads thumbnail links only for that page, reusing them when you come back", async () => {
    await act(async () => root.render(createElement(AssetsTab, { data, reload: async () => undefined })));
    await flush();
    expect(cards()).toBe(20);
    expect(host.querySelector('[data-testid="asset-pages"]')?.textContent).toContain("1–20 of 45 · Page 1 of 3");
    expect(api.signedAssetUrlsApi).toHaveBeenCalledTimes(1);
    expect(api.signedAssetUrlsApi.mock.calls[0][0]).toHaveLength(20);
    expect(api.signedAssetUrlsApi.mock.calls[0][2]).toBe("thumb");
    const img = host.querySelector<HTMLImageElement>('[data-testid="asset-card"] img')!;
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("decoding")).toBe("async");

    await act(async () => button("Next").click());
    await flush();
    expect(cards()).toBe(20);
    expect(api.signedAssetUrlsApi).toHaveBeenCalledTimes(2);
    await act(async () => button("Next").click());
    await flush();
    expect(cards()).toBe(5);
    expect(button("Next").disabled).toBe(true);
    expect(api.signedAssetUrlsApi.mock.calls[2][0]).toHaveLength(5);

    // Back to page 1: links already fetched are reused (no new request).
    await act(async () => button("Previous").click());
    await act(async () => button("Previous").click());
    await flush();
    expect(api.signedAssetUrlsApi).toHaveBeenCalledTimes(3);
    expect(host.querySelector<HTMLImageElement>('[data-testid="asset-card"] img')!.src).toContain("/thumb/");
  });

  it("offers Make thumbnails for older photos with no small thumbnail", async () => {
    const old = { ...data, assets: [{ ...asset(1), poster_path: null }, asset(2)] } as unknown as MarketingData;
    await act(async () => root.render(createElement(AssetsTab, { data: old, reload: async () => undefined })));
    expect(host.querySelector('[data-testid="make-thumbnails"]')?.textContent).toContain("1 older photo has no small thumbnail yet");
    expect(host.querySelector('[data-testid="asset-pages"]')).toBeNull();
  });
});
