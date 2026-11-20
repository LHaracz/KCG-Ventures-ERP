// @vitest-environment jsdom
// HEIC, GIF and MP4 uploads in the Add assets dialog, with a mocked converter
// and a mocked storage PUT. Invented files and names only.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const api = vi.hoisted(() => ({
  assetUploadUrlApi: vi.fn(),
  finalizeAssetApi: vi.fn(),
  createLinkAssetApi: vi.fn(),
  updateAssetApi: vi.fn(),
  signedAssetUrlsApi: vi.fn(async () => ({ urls: {} })),
}));
const converter = vi.hoisted(() => ({ makeMediaPreview: vi.fn() }));
vi.mock("@/lib/growth/client", () => ({
  ...api,
  GrowthApiError: class extends Error {
    constructor(message: string, public status = 400, public fields: Record<string, string> | null = null) {
      super(message);
    }
  },
}));
vi.mock("@/lib/growth/mediaPreview", () => converter);
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/components/growth/useUrlParams", () => ({ useUrlParams: () => ({ get: (_k: string, d = "") => d, set: vi.fn(), query: "" }) }));

import { AddAssetsDialog, AssetsTab, NO_PREVIEW } from "@/components/growth/AssetLibrary";
import { uploadTransport } from "@/lib/growth/assetUpload";
import type { MarketingData } from "@/lib/growth/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MB = 1024 * 1024;
const enc = (s: string) => [...s].map((c) => c.charCodeAt(0));
const HEIC = new Uint8Array([0, 0, 0, 0x18, ...enc("ftypheic"), 0, 0, 0, 0, ...enc("mif1heic"), 1, 2, 3, 4]);
const MP4 = new Uint8Array([0, 0, 0, 0x18, ...enc("ftypmp42"), 0, 0, 0, 0, ...enc("isommp42"), 1, 2, 3, 4]);
const PATH = "assets/2026-11/00000000-0000-4000-8000-0000000000aa.heic";
const data = (assets: unknown[] = []) => ({ products: [], ingredientTags: [], profiles: [], assetProductLinks: [], assetIngredientLinks: [], assetCategories: [{ key: "product", label: "Product", sort_order: 10, is_builtin: true }, { key: "group_product", label: "Group product", sort_order: 20, is_builtin: true }, { key: "ingredient", label: "Ingredient", sort_order: 30, is_builtin: true }, { key: "market", label: "Markets", sort_order: 40, is_builtin: true }, { key: "retail", label: "Retail", sort_order: 50, is_builtin: true }, { key: "other", label: "Other", sort_order: 1000, is_builtin: true }], assets }) as unknown as MarketingData;

let host: HTMLDivElement;
let root: Root;
let put: MockInstance<typeof uploadTransport.put>;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  vi.clearAllMocks();
  put = vi.spyOn(uploadTransport, "put").mockResolvedValue(undefined);
  api.assetUploadUrlApi.mockImplementation(async (body: { extra?: string }) => ({
    path: PATH,
    token: "t",
    signedUrl: "https://storage.example.test/upload/original",
    extra: body.extra ? { kind: body.extra, path: `${PATH}.${body.extra}.jpg`, token: "t2", signedUrl: "https://storage.example.test/upload/preview" } : null,
  }));
  api.finalizeAssetApi.mockImplementation(async (body: Record<string, unknown>) => ({ asset: { id: "a1", ...body } }));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  put.mockRestore();
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(text))!;
async function render() {
  await act(async () => root.render(createElement(AddAssetsDialog, { data: data(), onClose: () => undefined, onDone: () => undefined, reload: async () => undefined })));
}
async function addFile(file: File) {
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Files"]')!;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await flush();
}
async function chooseMarketAndSave() {
  const radio = [...host.querySelectorAll<HTMLInputElement>('input[name="asset-category"]')][3]; // Markets
  await act(async () => radio.click());
  await act(async () => button("Save").click());
  for (let i = 0; i < 5; i++) await flush();
}

describe("HEIC uploads", () => {
  it("uploads the original (as image/heic, though the browser declared nothing) and the JPG preview", async () => {
    converter.makeMediaPreview.mockResolvedValue({ extra: "preview", blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" }), width: 4032, height: 3024, duration_seconds: null });
    await render();
    await addFile(new File([HEIC], "IMG_0001.HEIC", { type: "" }));
    expect(host.querySelector('[data-testid="add-kind"]')?.textContent).toMatch(/^HEIC · /);
    await chooseMarketAndSave();
    expect(converter.makeMediaPreview).toHaveBeenCalledWith(expect.any(File), "heic");
    expect(api.assetUploadUrlApi).toHaveBeenCalledWith(expect.objectContaining({ mime_type: "image/heic", extra: "preview" }));
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[0][2]).toBe("image/heic");
    expect(put.mock.calls[1][2]).toBe("image/jpeg");
    expect(api.finalizeAssetApi).toHaveBeenCalledWith(expect.objectContaining({ title: "IMG_0001", mime_type: "image/heic", preview_path: `${PATH}.preview.jpg`, poster_path: null, width: 4032, height: 3024 }));
    expect(host.querySelector('[data-testid="add-status"]')?.textContent).toBe("Saved");
  });

  it("a failed conversion still saves the original, and the grid shows the placeholder", async () => {
    converter.makeMediaPreview.mockResolvedValue({ extra: "preview", blob: null, width: null, height: null, duration_seconds: null });
    await render();
    await addFile(new File([HEIC], "IMG_0002.heic", { type: "" }));
    await chooseMarketAndSave();
    expect(put).toHaveBeenCalledTimes(1);
    expect(api.assetUploadUrlApi).toHaveBeenCalledWith(expect.objectContaining({ mime_type: "image/heic", extra: undefined }));
    expect(api.finalizeAssetApi).toHaveBeenCalledWith(expect.objectContaining({ preview_path: null }));
    expect(host.querySelector('[data-testid="add-status"]')?.textContent).toBe("Saved (no preview)");

    const saved = { id: "a1", title: "IMG_0002", source: "upload", mime_type: "image/heic", file_path: PATH, preview_path: null, poster_path: null, status: "draft", asset_type: "photo", business: "botaniqals", category: "market", url: null, duration_seconds: null };
    await act(async () => root.render(createElement(AssetsTab, { data: data([saved]), reload: async () => undefined })));
    expect(host.querySelector('[data-testid="asset-placeholder"]')?.textContent).toContain(NO_PREVIEW);
    expect(host.textContent).toContain("No preview");
    expect(host.textContent).toContain("HEIC");
  });
});

describe("MP4 checks before upload", () => {
  it("rejects an oversize MP4 before anything is uploaded", async () => {
    await render();
    const big = new File([MP4], "Clip A.mp4", { type: "video/mp4" });
    Object.defineProperty(big, "size", { value: 200 * MB + 1 });
    await addFile(big);
    expect(host.textContent).toContain("MP4 files can be up to 200 MB. Paste a link for larger videos.");
    expect(host.querySelector('[data-testid="add-assets-table"]')).toBeNull();
    expect(api.assetUploadUrlApi).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects an .mp4 that is really text", async () => {
    await render();
    await addFile(new File(["this is only text, not a video"], "Clip B.mp4", { type: "video/mp4" }));
    expect(host.textContent).toContain("isn't a real MP4 file");
    expect(host.querySelector('[data-testid="add-assets-table"]')).toBeNull();
    expect(api.assetUploadUrlApi).not.toHaveBeenCalled();
  });
});
