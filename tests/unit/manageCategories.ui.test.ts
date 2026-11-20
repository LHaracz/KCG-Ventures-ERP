// @vitest-environment jsdom
// Marketing Hub › Assets › Manage categories. API calls mocked; invented data only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const api = vi.hoisted(() => ({ createAssetCategoryApi: vi.fn(), deleteAssetCategoryApi: vi.fn() }));
vi.mock("@/lib/growth/client", () => ({ ...api, GrowthApiError: class extends Error {} }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));

import { ManageCategoriesDialog } from "@/components/growth/AssetLibrary";
import type { MarketingData } from "@/lib/growth/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const data = {
  assetCategories: [
    { key: "product", label: "Product", sort_order: 10, is_builtin: true },
    { key: "c_a", label: "Category A", sort_order: 60, is_builtin: false },
  ],
  assets: [{ id: "a1", category: "product", status: "archived" }],
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
const btn = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const byText = (t: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === t)!;

describe("Manage categories", () => {
  it("adds a category", async () => {
    api.createAssetCategoryApi.mockResolvedValue({ category: { key: "c_b", label: "Production", sort_order: 70, is_builtin: false } });
    const reload = vi.fn(async () => undefined);
    await act(async () => root.render(createElement(ManageCategoriesDialog, { data, reload, onClose: () => undefined })));
    const input = host.querySelector<HTMLInputElement>('input[aria-label="New category name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Production");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => byText("Add category").click());
    await flush();
    expect(api.createAssetCategoryApi).toHaveBeenCalledWith("Production");
    expect(reload).toHaveBeenCalled();
    expect(host.textContent).toContain("Added Production.");
  });

  it("can't delete a category that has assets (archived count); deletes an empty one after confirming", async () => {
    api.deleteAssetCategoryApi.mockResolvedValue({ deleted: "Category A" });
    const onDeleted = vi.fn();
    await act(async () => root.render(createElement(ManageCategoriesDialog, { data, reload: async () => undefined, onClose: () => undefined, onDeleted })));
    expect(btn("Delete Product").disabled).toBe(true);
    expect(host.textContent).toContain("1 asset uses this category (1 archived). Move it to another category first.");
    expect(btn("Delete Category A").disabled).toBe(false);
    await act(async () => btn("Delete Category A").click());
    expect(host.textContent).toContain("Delete Category A?");
    const confirmDelete = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Delete" && !b.getAttribute("aria-label"))!;
    await act(async () => confirmDelete.click());
    await flush();
    expect(api.deleteAssetCategoryApi).toHaveBeenCalledWith("c_a");
    expect(onDeleted).toHaveBeenCalledWith("c_a");
    expect(host.textContent).toContain("Deleted Category A.");
  });
});
