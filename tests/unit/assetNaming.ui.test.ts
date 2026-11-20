// @vitest-environment jsdom
// Marketing Hub assets: naming on upload, blank names blocked, rename.
// Components rendered with React in jsdom; API calls mocked. Invented data only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const api = vi.hoisted(() => ({
  uploadAsset: vi.fn(),
  createLinkAssetApi: vi.fn(),
  updateAssetApi: vi.fn(),
  signedAssetUrlsApi: vi.fn(async () => ({ urls: {} })),
}));
vi.mock("@/lib/growth/client", () => ({ ...api, GrowthApiError: class extends Error {} }));
vi.mock("@/lib/growth/assetUpload", async (importOriginal) => ({ ...(await importOriginal<object>()), uploadAsset: api.uploadAsset }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/components/growth/useUrlParams", () => ({ useUrlParams: () => ({ get: (_k: string, d = "") => d, set: vi.fn(), query: "" }) }));

import { AddAssetsDialog, AssetsTab, RenameAsset } from "@/components/growth/AssetLibrary";
import type { MarketingData } from "@/lib/growth/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const asset = (over: Record<string, unknown> = {}) => ({
  id: "00000000-0000-4000-8000-000000000001",
  title: "Photo A",
  business: "botaniqals",
  formulation_product_id: null,
  asset_type: "photo",
  source: "upload",
  file_path: "assets/2026-11/00000000-0000-4000-8000-0000000000aa.png",
  url: null,
  mime_type: "image/png",
  size_bytes: 10,
  project_url: null,
  status: "draft",
  notes: null,
  created_by_name: "Test Person",
  created_at: "2026-11-01T12:00:00Z",
  category: "market",
  context_label: null,
  shot_date: null,
  is_full_lineup: false,
  ...over,
});
const data = (assets: unknown[] = []) => ({ products: [], ingredientTags: [], profiles: [], assetProductLinks: [], assetIngredientLinks: [], assets }) as unknown as MarketingData;

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

const typeInto = (el: HTMLInputElement, v: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const byLabel = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(text))!;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function addFile(name: string) {
  const input = byLabel("Files");
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const file = new File([PNG], name, { type: "image/png" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await flush();
  return file;
}
async function chooseMarket() {
  const radio = [...host.querySelectorAll<HTMLInputElement>('input[name="asset-category"]')][3]; // market
  await act(async () => radio.click());
}

describe("adding assets", () => {
  it("prefills the name from the file, saves a custom name, and the grid shows it", async () => {
    api.uploadAsset.mockResolvedValue({ asset: asset({ title: "Gum flat lay" }) });
    await act(async () => root.render(createElement(AddAssetsDialog, { data: data(), onClose: () => undefined, onDone: () => undefined, reload: async () => undefined })));
    await addFile("IMG_4821.PNG");
    expect(byLabel("Name").value).toBe("IMG_4821");
    await chooseMarket();
    await act(async () => typeInto(byLabel("Name"), "Gum flat lay"));
    await act(async () => button("Save").click());
    await flush();
    expect(api.uploadAsset).toHaveBeenCalledTimes(1);
    expect(api.uploadAsset.mock.calls[0][1]).toMatchObject({ title: "Gum flat lay" });

    await act(async () => root.render(createElement(AssetsTab, { data: data([asset({ title: "Gum flat lay" })]), reload: async () => undefined })));
    const names = [...host.querySelectorAll('[data-testid="asset-name"]')].map((n) => n.textContent);
    expect(names).toEqual(["Gum flat lay"]);
    expect(host.textContent).not.toContain("0000000000aa");
  });

  it("blocks a blank name", async () => {
    await act(async () => root.render(createElement(AddAssetsDialog, { data: data(), onClose: () => undefined, onDone: () => undefined, reload: async () => undefined })));
    await addFile("Photo.png");
    await chooseMarket();
    await act(async () => typeInto(byLabel("Name"), "   "));
    await act(async () => button("Save").click());
    await flush();
    expect(api.uploadAsset).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Enter a name.");
  });

  it("names checked rows with the Name pattern", async () => {
    await act(async () => root.render(createElement(AddAssetsDialog, { data: data(), onClose: () => undefined, onDone: () => undefined, reload: async () => undefined })));
    await addFile("one.png");
    await addFile("two.png");
    await act(async () => typeInto(byLabel("Name pattern"), "Gum flat lay {n}"));
    expect(host.querySelector('[data-testid="name-pattern-preview"]')?.textContent).toContain("Gum flat lay 1, Gum flat lay 2");
    await act(async () => button("Apply to").click());
    expect([...host.querySelectorAll<HTMLInputElement>('input[aria-label="Name"]')].map((i) => i.value)).toEqual(["Gum flat lay 1", "Gum flat lay 2"]);
  });
});

describe("rename", () => {
  it("saves the new name on Enter", async () => {
    api.updateAssetApi.mockResolvedValue({ asset: asset({ title: "Photo B" }) });
    const onDone = vi.fn();
    await act(async () => root.render(createElement(RenameAsset, { asset: { id: "a1", title: "Photo A" }, assets: [], onDone })));
    const input = byLabel("Name");
    await act(async () => typeInto(input, "Photo B"));
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await flush();
    expect(api.updateAssetApi).toHaveBeenCalledWith("a1", { title: "Photo B" });
    expect(onDone).toHaveBeenCalledWith(true, "Photo B");
  });

  it("Escape cancels without saving", async () => {
    const onDone = vi.fn();
    await act(async () => root.render(createElement(RenameAsset, { asset: { id: "a1", title: "Photo A" }, assets: [], onDone })));
    const input = byLabel("Name");
    await act(async () => typeInto(input, "Photo C"));
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(api.updateAssetApi).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledWith(false);
  });
});
