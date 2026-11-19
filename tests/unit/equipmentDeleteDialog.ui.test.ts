// @vitest-environment jsdom
// Procurement › Equipment: the Admin-only delete dialog and buttons.
// Rendered with React in jsdom; API calls mocked. Invented data only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const api = vi.hoisted(() => ({ previewEquipmentDeleteApi: vi.fn(), deleteEquipmentApi: vi.fn() }));
vi.mock("@/lib/procurement/client", () => ({ ...api, ProcurementApiError: class extends Error {} }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import { DeleteEquipmentDialog, EquipmentModal } from "@/components/procurement/ProcurementForms";
import { EquipmentTable, type EquipmentHandlers } from "@/components/procurement/ProcurementUi";
import { deleteResultMessage, keptReason } from "@/lib/procurement/equipmentDelete";
import type { EquipmentRow } from "@/lib/procurement/view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

const EQ = "00000000-0000-4000-8000-0000000000e1";
const preview = {
  equipment_id: EQ,
  equipment_name: "Equipment A",
  listing_count: 3,
  suppliers: [
    { id: "s1", name: "Supplier A", willDelete: true, reason: null },
    { id: "s2", name: "Supplier B", willDelete: false, reason: keptReason(["Material A", "Material B"], ["Equipment B"]) },
  ],
};

describe("DeleteEquipmentDialog", () => {
  it("lists the suppliers that will be deleted and kept, and sends only the deleted ones", async () => {
    api.previewEquipmentDeleteApi.mockResolvedValue(preview);
    api.deleteEquipmentApi.mockResolvedValue({ equipment_name: "Equipment A", deleted_suppliers: [{ id: "s1", name: "Supplier A" }], kept_suppliers: [{ id: "s2", name: "Supplier B", reason: "used for other ingredients or equipment" }] });
    const onDeleted = vi.fn();
    await act(async () => root.render(createElement(DeleteEquipmentDialog, { equipmentId: EQ, onClose: () => undefined, onDeleted })));
    await flush();
    expect(host.textContent).toContain("Delete Equipment A?");
    expect(host.textContent).toContain("This permanently deletes the equipment and its 3 supplier listings. This cannot be undone.");
    expect(host.querySelector('[data-testid="delete-suppliers"]')?.textContent).toBe("Supplier A");
    expect(host.querySelector('[data-testid="keep-suppliers"]')?.textContent).toBe(
      "Supplier B: Also used for 2 ingredients and 1 other equipment item (Material A, Material B, Equipment B)",
    );
    expect(document.activeElement?.textContent).toBe("Keep");
    await act(async () => button("Delete permanently")!.click());
    await flush();
    expect(api.deleteEquipmentApi).toHaveBeenCalledWith(EQ, ["s1"]);
    expect(onDeleted).toHaveBeenCalledWith("Deleted Equipment A. Also deleted: Supplier A. Kept: Supplier B.");
  });

  it("shows a failed delete in the dialog", async () => {
    api.previewEquipmentDeleteApi.mockResolvedValue(preview);
    api.deleteEquipmentApi.mockRejectedValue(new Error("Only an Admin can delete equipment."));
    const onDeleted = vi.fn();
    await act(async () => root.render(createElement(DeleteEquipmentDialog, { equipmentId: EQ, onClose: () => undefined, onDeleted })));
    await flush();
    await act(async () => button("Delete permanently")!.click());
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Only an Admin can delete equipment.");
    expect(onDeleted).not.toHaveBeenCalled();
  });
});

describe("Delete buttons show only for Admins", () => {
  const item = { id: EQ, name: "Equipment A", category_id: "c1", description: null, archived_at: null, created_at: "", updated_at: "", updated_by_name: null };
  const row = (archived: boolean) => ({ item, name: "Equipment A", category: null, archived, links: [], preferred: null, missingInfo: true, missingPrice: false }) as unknown as EquipmentRow;
  const handlers = (admin: boolean): EquipmentHandlers => ({
    onToggle: vi.fn(), onEditItem: vi.fn(), onRestore: vi.fn(), onAddSupplier: vi.fn(), onEditLink: vi.fn(), onEditSupplier: vi.fn(),
    onRemoveLink: vi.fn(), onMakePreferred: vi.fn(), onCreatePo: vi.fn(), onDelete: admin ? vi.fn() : undefined,
  });

  it("archived rows: Restore for everyone, Delete for Admins", async () => {
    await act(async () => root.render(createElement(EquipmentTable, { rows: [row(true)], expanded: new Set<string>(), handlers: handlers(false) })));
    expect(button("Restore")).toBeTruthy();
    expect(host.querySelector('[data-testid="equipment-delete"]')).toBeNull();
    const h = handlers(true);
    await act(async () => root.render(createElement(EquipmentTable, { rows: [row(true)], expanded: new Set<string>(), handlers: h })));
    await act(async () => (host.querySelector('[data-testid="equipment-delete"]') as HTMLButtonElement).click());
    expect(h.onDelete).toHaveBeenCalledTimes(1);
  });

  it("the expanded subtable header shows Delete equipment for Admins only", async () => {
    await act(async () => root.render(createElement(EquipmentTable, { rows: [row(false)], expanded: new Set([EQ]), handlers: handlers(false) })));
    expect(button("Delete equipment")).toBeUndefined();
    await act(async () => root.render(createElement(EquipmentTable, { rows: [row(false)], expanded: new Set([EQ]), handlers: handlers(true) })));
    expect(button("Delete equipment")).toBeTruthy();
  });

  it("the Edit dialog offers Delete only when given (Admins) and no longer offers Archive", async () => {
    const props = { item, categories: [{ id: "c1", name: "Production", sort_order: 1, archived_at: null, created_at: "" }], onClose: vi.fn(), onSaved: vi.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await act(async () => root.render(createElement(EquipmentModal, props as any)));
    expect(button("Delete…")).toBeUndefined();
    expect(host.textContent).not.toContain("Archive");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await act(async () => root.render(createElement(EquipmentModal, { ...props, onDelete: vi.fn() } as any)));
    expect(button("Delete…")).toBeTruthy();
  });
});

describe("messages", () => {
  it("names up to three uses and the result line", () => {
    expect(keptReason(["Material A"], [])).toBe("Also used for 1 ingredient (Material A)");
    expect(keptReason(["M1", "M2"], ["E1", "E2"])).toBe("Also used for 2 ingredients and 2 other equipment items (M1, M2, E1, and 1 more)");
    expect(deleteResultMessage({ equipment_name: "Equipment A", deleted_suppliers: [], kept_suppliers: [] })).toBe("Deleted Equipment A. Also deleted: none. Kept: none.");
  });
});
