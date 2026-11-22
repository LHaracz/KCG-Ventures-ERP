// @vitest-environment jsdom
// The Receiving Log form in the browser: full mode shows today's fields,
// simple mode shows only quantity, expiry, invoice and notes, changing the
// supplier to one with another policy switches the mode and keeps shared
// values, a simple receipt submits without lot number, COA or expiry in the
// material's own unit, "Use the full form" switches modes, the supplier
// dropdown puts pinned suppliers first with a Listed chip, and "Add new
// supplier" is hidden without Procurement access. Supabase, access and the
// router are mocked. Invented data only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const state = vi.hoisted(() => ({ features: new Set<string>(["compliance.logs", "inventory.purchase_orders"]), push: vi.fn() }));
const materials = [
  { id: "mA", name: "Ingredient A", unit: "g", quantity_on_hand: 100 },
  { id: "mB", name: "Jar A", unit: "pcs", quantity_on_hand: 10 },
];
const suppliers = [
  { id: "sZ", name: "Supplier Z", is_pinned: false },
  { id: "sA", name: "Supplier A", is_pinned: false },
  { id: "sAm", name: "Amazon", is_pinned: true },
];
const listings: Record<string, string> = { "mA|sA": "included", "mB|sA": "request", "mB|sZ": "not_available" };
const fakeSupabase = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: "token" } } })) },
  storage: { from: vi.fn() },
}));

vi.mock("@/components/InstantProvider", () => ({ useSupabase: () => ({ user: { id: "u1" }, supabase: fakeSupabase, isLoading: false }) }));
vi.mock("@/components/access/AccessProvider", () => ({
  useAccess: () => ({ has: (k: string) => state.features.has(k), hasAny: () => true, me: { fullName: "Test Person", active: true }, loading: false }),
}));
vi.mock("@/components/access/People", () => ({ YouName: ({ label }: { label: string }) => createElement("div", null, `${label}: Test Person`) }));
vi.mock("@/components/access/FeatureLink", () => ({
  FeatureLink: ({ children, href }: { children: unknown; href: string }) => createElement("a", { href }, children as never),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("@/lib/procurement/client", () => ({ createSupplierApi: vi.fn() }));

import { ReceivingEntryForm } from "@/components/ReceivingEntryForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const logType = { id: "lt1", name: "Receiving Log", slug: "receiving", special_type: "receiving", linked_sop_id: null } as never;

let host: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();
beforeEach(() => {
  window.localStorage.clear();
  state.features = new Set(["compliance.logs", "inventory.purchase_orders"]);
  state.push.mockReset();
  fakeSupabase.from.mockImplementation(() => ({ select: () => ({ order: async () => ({ data: materials, error: null }) }) }));
  fakeSupabase.rpc.mockImplementation(async (name: string, args: Record<string, string | null>) => {
    if (name === "list_suppliers_for_receiving") {
      return { data: suppliers.map((s) => ({ ...s, listed_for: !!listings[`${args.p_raw_material_id}|${s.id}`] })), error: null };
    }
    if (name === "coa_policy_for") return { data: listings[`${args.p_raw_material_id}|${args.p_supplier_id}`] ?? null, error: null };
    return { data: null, error: { message: "unknown rpc" } };
  });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ entryId: "e1" }) });
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const render = async () => {
  await act(async () => root.render(createElement(ReceivingEntryForm, { logType, correctsEntryId: null, preselectRawMaterialId: null })));
  await flush();
  await flush();
};
const byText = (re: RegExp, sel = "button") => [...host.querySelectorAll<HTMLElement>(sel)].find((b) => re.test(b.textContent ?? ""));
const click = async (el: Element | null | undefined) => {
  expect(el, "element").toBeTruthy();
  await act(async () => (el as HTMLElement).click());
  await flush();
};
const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const chooseMaterial = async (id: string) => {
  const sel = host.querySelector<HTMLSelectElement>('select[aria-label="Raw material"]')!;
  await act(async () => {
    sel.value = id;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
};
const chooseSupplier = async (name: string) => {
  await click(host.querySelector('[data-testid="supplier-button"]'));
  await click([...host.querySelectorAll('[data-testid="supplier-option"]')].find((o) => o.textContent?.startsWith(name)));
  await flush();
};
const labels = (testId: string) => [...(host.querySelector(`[data-testid="${testId}"]`)?.querySelectorAll("label") ?? [])].map((l) => l.textContent?.trim());

describe("receiving form modes", () => {
  it("no mode fields until both the raw material and the supplier are chosen; full mode shows today's fields", async () => {
    await render();
    expect(host.querySelector('[data-testid="choose-first"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="full-fields"]')).toBeNull();
    await chooseMaterial("mA");
    expect(host.querySelector('[data-testid="full-fields"]')).toBeNull();
    await chooseSupplier("Supplier A");
    expect(labels("full-fields")).toEqual([
      "Supplier lot number",
      "Quantity received (grams)",
      "Expiration / retest date",
      "PO / invoice number",
      "Packaging intact",
      "Identity verified against COA/label",
      "COA received",
      "Notes",
      "Documents",
    ]);
    expect(host.querySelector('[data-testid="simple-fields"]')).toBeNull();
  });

  it("simple mode shows only quantity (in the material's unit), expiry, invoice and notes, with the policy line", async () => {
    await render();
    await chooseMaterial("mB");
    await chooseSupplier("Supplier Z");
    expect(labels("simple-fields")).toEqual(["Quantity received", "Expiration date (optional)", "Invoice number (optional)", "Notes (optional)"]);
    expect(host.querySelector("#receiving-simple-unit")?.textContent).toBe("pcs");
    expect(host.querySelector('[data-testid="policy-line"]')?.textContent).toContain("COA policy: Not provided. Receiving without a lot number or COA.");
    expect(host.textContent).not.toContain("Supplier lot number");
    expect(host.textContent).not.toContain("COA received");
    await type(host.querySelector<HTMLInputElement>("#receiving-simple-qty")!, "24");
    expect(host.querySelector('[data-testid="qty-preview"]')?.textContent).toContain("Will add 24 pcs to Jar A (currently 10)");
  });

  it("no listing for the pair: simple, with the Procurement hint", async () => {
    await render();
    await chooseMaterial("mA");
    await chooseSupplier("Supplier Z");
    expect(host.querySelector('[data-testid="policy-line"]')?.textContent).toContain("No COA policy set for this supplier and ingredient. Set it in Procurement.");
  });

  it("changing the supplier to one with another policy switches the mode and keeps shared values", async () => {
    await render();
    await chooseMaterial("mB");
    await chooseSupplier("Supplier Z");
    await type(host.querySelector<HTMLInputElement>("#receiving-simple-invoice")!, "INV-7");
    await type(host.querySelector<HTMLTextAreaElement>("#receiving-simple-notes")!, "Box of jars");
    await type(host.querySelector<HTMLInputElement>("#receiving-simple-qty")!, "12");
    await chooseSupplier("Supplier A"); // 'request' → full
    expect(host.querySelector('[data-testid="full-fields"]')).toBeTruthy();
    expect(host.querySelector<HTMLInputElement>("#receiving-po")!.value).toBe("INV-7");
    expect(host.querySelector<HTMLTextAreaElement>("#receiving-notes")!.value).toBe("Box of jars");
    expect(host.querySelector<HTMLInputElement>("#receiving-qty")!.value).toBe("12"); // pcs is not a mass unit, so the quantity still applies
    await type(host.querySelector<HTMLInputElement>("#receiving-lot")!, "LOT-1");
    await chooseSupplier("Supplier Z"); // back to simple: the lot number is dropped
    await chooseSupplier("Supplier A");
    expect(host.querySelector<HTMLInputElement>("#receiving-lot")!.value).toBe("");
  });

  it("a simple receipt submits without lot number, COA or expiry, in the material's own unit", async () => {
    await render();
    await chooseMaterial("mB");
    await chooseSupplier("Supplier Z");
    await type(host.querySelector<HTMLInputElement>("#receiving-simple-qty")!, "24");
    await click(byText(/^Save Entry$/));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/compliance/logs/receiving");
    expect(JSON.parse(init.body)).toMatchObject({
      rawMaterialId: "mB",
      supplierId: "sZ",
      entryMode: "simple",
      forcedFull: false,
      quantityAdded: 24,
      materialUnitAtReceipt: "pcs",
      supplierLotNumber: null,
      quantityReceivedGrams: null,
      packagingIntact: null,
      identityVerified: null,
      coaReceived: null,
      expirationDate: null,
      files: [],
    });
    expect(state.push).toHaveBeenCalledWith("/compliance/logs/entries/e1");
  });

  it("'Use the full form' switches to the full form (and back)", async () => {
    await render();
    await chooseMaterial("mB");
    await chooseSupplier("Supplier Z");
    await click(byText(/Use the full form/));
    expect(host.querySelector('[data-testid="full-fields"]')).toBeTruthy();
    await click(byText(/Use the simple form instead/));
    expect(host.querySelector('[data-testid="simple-fields"]')).toBeTruthy();
  });
});

describe("supplier dropdown", () => {
  it("pinned suppliers first, then alphabetical, with a Listed chip for the chosen material", async () => {
    await render();
    await chooseMaterial("mB");
    await click(host.querySelector('[data-testid="supplier-button"]'));
    const options = [...host.querySelectorAll('[data-testid="supplier-option"]')].map((o) => o.textContent);
    expect(options).toEqual(["Amazon", "Supplier AListed", "Supplier ZListed"]);
    expect(host.querySelector('[data-testid="add-supplier"]')).toBeTruthy();
  });
  it("'Add new supplier' is hidden without Procurement access", async () => {
    state.features = new Set(["compliance.logs"]);
    await render();
    await click(host.querySelector('[data-testid="supplier-button"]'));
    expect(host.querySelector('[data-testid="add-supplier"]')).toBeNull();
    expect(host.textContent).toContain("Ask someone with Procurement access to add a missing supplier.");
  });
});
