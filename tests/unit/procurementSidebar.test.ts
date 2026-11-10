// Sidebar protection and access for Procurement. The only allowed sidebar
// change is Inventory › "Purchase Orders" becoming "Procurement" in the same
// position; everything else must match the structure recorded before this
// build. Invented people and example.test addresses only.
import { describe, expect, it, vi } from "vitest";
import {
  ALL_SECTIONS,
  API_RULES,
  EMPLOYEES_ITEM,
  FEATURES,
  PAGE_RULES,
  TOP_ITEMS,
  allows,
  apiRule,
  buildSidebar,
  navItemActive,
  pageRule,
} from "@/lib/access/catalog";
import { decidePage } from "@/lib/access/server";

const BEFORE = {
  top: [
    { href: "/", label: "Dashboard" },
    { href: "/schedule", label: "Schedule" },
    { href: "/notifications", label: "Alerts" },
    { href: "/settings/notifications", label: "Notification Settings", admin: true },
  ],
  employees: { href: "/employees", label: "Employees", admin: true },
  sections: [
    {
      title: "BotanIQals",
      categories: [
        {
          title: "Production",
          items: [
            { href: "/calibration", label: "Freeze Dryer Calibration" },
            { href: "/products", label: "Products & BOM" },
            { href: "/formulation", label: "Formulation" },
            { href: "/cycles", label: "Production Cycles & Planner" },
            { href: "/production-optimization", label: "Production Optimization" },
          ],
        },
        {
          title: "Inventory",
          items: [
            { href: "/finished-products-inventory", label: "Finished Products Inventory" },
            { href: "/inventory", label: "Raw Materials" },
            { href: "/inventory/purchase-orders", label: "Purchase Orders" },
          ],
        },
        {
          title: "Fulfillment",
          items: [
            { href: "/fulfillments", label: "Fulfillments" },
            { href: "/fulfillments/pick-list", label: "Pick List" },
            { href: "/sales-data", label: "Sales Data" },
            { href: "/stats", label: "Sales Stats" },
          ],
        },
        {
          title: "Compliance",
          items: [
            { href: "/compliance/sops", label: "SOPs" },
            { href: "/compliance/logs", label: "Logs" },
            { href: "/compliance/coas", label: "COAs" },
          ],
        },
      ],
    },
    {
      title: "MiniLeaf",
      items: [
        { href: "/microgreens", label: "Microgreens Guide" },
        { href: "/yield", label: "Yield Logging" },
        { href: "/microgreen-optimization", label: "Microgreens Optimization" },
      ],
    },
  ],
};

describe("sidebar", () => {
  it("is the recorded structure with only Purchase Orders replaced by Procurement, in the same position", () => {
    const expected = JSON.parse(JSON.stringify(BEFORE.sections));
    const inventory = expected[0].categories[1].items;
    expect(inventory[2]).toEqual({ href: "/inventory/purchase-orders", label: "Purchase Orders" });
    inventory[2] = { href: "/inventory/procurement", label: "Procurement" };
    expect(ALL_SECTIONS).toEqual(expected);
  });

  it("top items and the Employees item are unchanged", () => {
    expect(TOP_ITEMS).toEqual(BEFORE.top);
    expect(EMPLOYEES_ITEM).toEqual(BEFORE.employees);
  });

  it("Procurement shows for exactly the people who saw Purchase Orders", () => {
    const po = buildSidebar({ active: true, isAdmin: false, features: new Set(["inventory.purchase_orders"]) });
    expect(po.sections).toEqual([{ title: "BotanIQals", categories: [{ title: "Inventory", items: [{ href: "/inventory/procurement", label: "Procurement" }] }] }]);
    const raw = buildSidebar({ active: true, isAdmin: false, features: new Set(["inventory.raw_materials"]) });
    expect(JSON.stringify(raw)).not.toContain("procurement");
  });

  it("Procurement stays highlighted on Procurement, Suppliers and every Purchase Orders page", () => {
    for (const p of [
      "/inventory/procurement",
      "/inventory/procurement/suppliers",
      "/inventory/purchase-orders",
      "/inventory/purchase-orders/new",
      "/inventory/purchase-orders/settings",
      "/inventory/purchase-orders/123e4567-e89b-42d3-a456-426614174000",
      "/inventory/purchase-orders/123e4567-e89b-42d3-a456-426614174000/edit",
    ]) {
      expect(navItemActive("/inventory/procurement", p), p).toBe(true);
    }
    expect(navItemActive("/inventory/procurement", "/inventory")).toBe(false);
    expect(navItemActive("/inventory/procurement", "/inventory/purchase-orders-old")).toBe(false);
    expect(navItemActive("/inventory/procurement", null)).toBe(false);
  });

  it("other items still highlight only on their own page", () => {
    expect(navItemActive("/inventory", "/inventory")).toBe(true);
    expect(navItemActive("/inventory", "/inventory/procurement")).toBe(false);
    expect(navItemActive("/inventory", "/inventory/purchase-orders")).toBe(false);
    expect(navItemActive("/fulfillments", "/fulfillments/pick-list")).toBe(false);
  });
});

describe("access", () => {
  const procurementPages = ["/inventory/procurement", "/inventory/procurement/suppliers"];
  const procurementApis = Object.keys(API_RULES).filter((k) => k.startsWith("/api/procurement"));

  it("Procurement pages and API routes are guarded by the Purchase Orders feature, with no new feature key", () => {
    expect(FEATURES.filter((f) => f.key.includes("procurement"))).toEqual([]);
    for (const p of procurementPages) expect(PAGE_RULES[p]).toEqual({ kind: "feature", features: ["inventory.purchase_orders"] });
    expect(procurementApis.length).toBe(9);
    for (const a of procurementApis) expect(API_RULES[a]).toEqual({ kind: "feature", features: ["inventory.purchase_orders"] });
    expect(apiRule("/api/procurement/links/123e4567-e89b-42d3-a456-426614174000/preferred")).toEqual({ kind: "feature", features: ["inventory.purchase_orders"] });
  });

  it("the feature's label and description name Procurement", () => {
    const f = FEATURES.find((x) => x.key === "inventory.purchase_orders")!;
    expect(f.label).toBe("Procurement (suppliers, buy links and Purchase Orders)");
    expect(f.description).toContain("Procurement (suppliers, buy links and Purchase Orders)");
  });

  it("Purchase Orders routes are unchanged", () => {
    for (const p of ["/inventory/purchase-orders", "/inventory/purchase-orders/new", "/inventory/purchase-orders/[id]", "/inventory/purchase-orders/[id]/edit", "/inventory/purchase-orders/settings"]) {
      expect(PAGE_RULES[p]).toEqual({ kind: "feature", features: ["inventory.purchase_orders"] });
    }
  });

  it("a role without the feature gets the forbidden page", () => {
    const user = { id: "00000000-0000-4000-8000-000000000009" } as never;
    const access = {
      userId: "u", accountId: "a", status: "active" as const, email: "raw1@example.test", firstName: "Rae", lastName: "Raw",
      roles: ["Raw only"], fullName: "Rae Raw", active: true, isAdmin: false, features: new Set(["inventory.raw_materials"]),
    };
    for (const p of [...procurementPages, "/inventory/purchase-orders/new"]) {
      expect(decidePage(p, { user, access, error: null })).toEqual({ kind: "forbidden" });
      expect(decidePage(p, { user, access: { ...access, features: new Set(["inventory.purchase_orders"]) }, error: null })).toEqual({ kind: "allow" });
    }
    expect(allows(pageRule("/inventory/procurement"), access, true)).toBe(false);
  });
});

// guardApi for real (catalog + access_for_user), with a fake service-role client.
const fake = vi.hoisted(() => ({ features: [] as string[] }));
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: async () => ({ data: { user: { id: "00000000-0000-4000-8000-000000000009" } }, error: null }) },
    rpc: async () => ({
      data: { account_id: "a1", status: "active", first_name: "Rae", last_name: "Raw", email: "raw1@example.test", is_admin: false, roles: ["Some role"], features: fake.features },
      error: null,
    }),
    from: () => {
      throw new Error("database not available in this test");
    },
  },
}));

import * as listRoute from "@/app/api/procurement/route";
import * as prefillRoute from "@/app/api/procurement/po-prefill/route";
import * as suppliersRoute from "@/app/api/procurement/suppliers/route";
import * as linksRoute from "@/app/api/procurement/links/route";

describe("API responses", () => {
  const req = (path: string, method: "GET" | "POST") =>
    new Request(`http://localhost/api/procurement${path}`, {
      method,
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: method === "POST" ? "{}" : undefined,
    });

  it("403 for a role without the Purchase Orders feature, on every Procurement route", async () => {
    fake.features = ["inventory.raw_materials"];
    expect((await listRoute.GET(req("", "GET"))).status).toBe(403);
    expect((await prefillRoute.POST(req("/po-prefill", "POST"))).status).toBe(403);
    expect((await suppliersRoute.POST(req("/suppliers", "POST"))).status).toBe(403);
    expect((await linksRoute.POST(req("/links", "POST"))).status).toBe(403);
  });

  it("passes the guard with the feature", async () => {
    fake.features = ["inventory.purchase_orders"];
    const res = await prefillRoute.POST(req("/po-prefill", "POST"));
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
    expect((await res.json()).error).toBe("Unknown supplier.");
  });
});
