// Sidebar protection and access for Retail (Admin only). The only allowed
// sidebar change is "Retail" as the last item in Fulfillment, for Admins.
// Every other category and item stays as recorded before the Retail build,
// for every role. Invented people and example.test addresses only.
import { withMarketingSales } from "./helpers/sidebarMoves";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ADMIN_ONLY_NOTE,
  ALL_SECTIONS,
  API_RULES,
  EMPLOYEES_ITEM,
  FEATURES,
  FEATURE_KEYS,
  PAGE_RULES,
  TOP_ITEMS,
  apiRule,
  buildSidebar,
  navItemActive,
  pageRule,
  previewSidebarLabels,
} from "@/lib/access/catalog";
import { decidePage } from "@/lib/access/server";

// The sidebar recorded before the Retail build.
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
            { href: "/inventory/procurement", label: "Procurement" },
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

const RETAIL = { href: "/fulfillment/retail", label: "Retail" };
const ROLES: Record<string, string[]> = {
  warehouse: ["inventory.finished_products", "inventory.raw_materials", "inventory.purchase_orders", "fulfillment.orders", "fulfillment.pick_list", "compliance.sops", "compliance.logs", "compliance.coas"],
  production: ["production.calibration", "production.products_bom", "production.planner", "production.optimization", "production.formulation", "inventory.finished_products", "inventory.raw_materials", "inventory.purchase_orders", "compliance.sops", "compliance.logs", "compliance.coas"],
  everything: [...FEATURE_KEYS],
  fulfillmentOnly: ["fulfillment.orders", "fulfillment.pick_list", "fulfillment.sales_data", "fulfillment.stats", "fulfillment.setup"],
};
const nonAdmin = (features: string[]) => ({ active: true, isAdmin: false, features: new Set(features) });

const expectedFor = (features: string[]) => buildSidebar(nonAdmin(features));

describe("Retail in the sidebar", () => {
  it("Admins: the recorded structure with Retail (later moved to Marketing & Sales), nothing else changed", () => {
    const expected = withMarketingSales(BEFORE.sections);
    expect(ALL_SECTIONS).toEqual(expected);
    const admin = buildSidebar({ active: true, isAdmin: true, features: new Set() });
    expect(admin.sections).toEqual(expected);
    const group = admin.sections[0].categories!.find((c) => c.title === "Marketing & Sales")!;
    expect(group.items).toContainEqual(RETAIL);
    expect(TOP_ITEMS).toEqual(BEFORE.top);
    expect(EMPLOYEES_ITEM).toEqual(BEFORE.employees);
  });

  it("non-admins never see Retail, and keep exactly their old sidebar", () => {
    const before = withMarketingSales(BEFORE.sections);
    for (const [name, features] of Object.entries(ROLES)) {
      const sb = expectedFor(features);
      expect(JSON.stringify(sb), name).not.toContain("/fulfillment/retail");
      // Same as filtering the recorded structure by the role's items.
      const allowedHrefs = new Set(sb.sections.flatMap((s) => [...(s.categories ?? []).flatMap((c) => c.items), ...(s.items ?? [])]).map((i) => i.href));
      type Item = { href: string; label: string };
      type Section = { title: string; categories?: { title: string; items: Item[] }[]; items?: Item[] };
      const filtered: Section[] = [];
      for (const sec of before as Section[]) {
        if (sec.categories) {
          const categories = sec.categories.map((c) => ({ title: c.title, items: c.items.filter((i) => allowedHrefs.has(i.href)) })).filter((c) => c.items.length > 0);
          if (categories.length > 0) filtered.push({ title: sec.title, categories });
        } else {
          const items = (sec.items ?? []).filter((i) => allowedHrefs.has(i.href));
          if (items.length > 0) filtered.push({ title: sec.title, items });
        }
      }
      expect(sb.sections, name).toEqual(filtered);
    }
    // A non-admin with every feature sees every item except the Admin-only ones.
    const all = buildSidebar(nonAdmin([...FEATURE_KEYS]));
    expect(JSON.stringify(all.sections)).toBe(JSON.stringify(before).replace(/,\{"href":"\/fulfillment\/retail","label":"Retail"\}/, ""));
    expect(all.employees).toBeNull();
  });

  it("someone with the old Fulfillment features keeps them (Sales Data and Sales Stats now under Marketing & Sales), without Retail", () => {
    const sb = buildSidebar(nonAdmin(ROLES.fulfillmentOnly));
    expect(sb.sections).toEqual([
      {
        title: "BotanIQals",
        categories: [
          { title: "Fulfillment", items: BEFORE.sections[0].categories![2].items.slice(0, 2) },
          { title: "Marketing & Sales", items: BEFORE.sections[0].categories![2].items.slice(2) },
        ],
      },
    ]);
  });

  it("Retail is never assignable: no feature key, not in the role editor preview, named in the Admin-only note", () => {
    expect(FEATURES.filter((f) => /retail|invoice/i.test(f.key) || f.label === "Retail")).toEqual([]);
    expect(previewSidebarLabels(FEATURE_KEYS).some((l) => l.includes("Retail"))).toBe(false);
    expect(ADMIN_ONLY_NOTE).toContain("Retail");
  });

  it("Retail stays highlighted on its own pages only", () => {
    for (const p of [
      "/fulfillment/retail",
      "/fulfillment/retail/settings",
      "/fulfillment/retail/retailers/123e4567-e89b-42d3-a456-426614174000",
      "/fulfillment/retail/invoices/new",
      "/fulfillment/retail/invoices/123e4567-e89b-42d3-a456-426614174000",
      "/fulfillment/retail/invoices/123e4567-e89b-42d3-a456-426614174000/edit",
    ]) {
      expect(navItemActive("/fulfillment/retail", p), p).toBe(true);
      expect(navItemActive("/fulfillments", p), p).toBe(false);
    }
    expect(navItemActive("/fulfillment/retail", "/fulfillments")).toBe(false);
    expect(navItemActive("/fulfillment/retail", "/fulfillment/retailers")).toBe(false);
  });
});

// --- Access rules -------------------------------------------------------------------------
function walk(dir: string, file: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, file));
    else if (name === file) out.push(p);
  }
  return out;
}
const toRoute = (root: string, file: string) => `/${path.relative(root, path.dirname(file)).split(path.sep).join("/")}`.replace(/\/$/, "") || "/";

describe("Retail access rules", () => {
  const appDir = path.join(process.cwd(), "src/app");
  const pages = walk(path.join(appDir, "fulfillment/retail"), "page.tsx").map((f) => toRoute(appDir, f));
  const apis = walk(path.join(appDir, "api/retail"), "route.ts").map((f) => toRoute(appDir, f));

  it("every Retail page and API route is registered as Admin only", () => {
    expect(pages.sort()).toEqual(
      [
        "/fulfillment/retail",
        "/fulfillment/retail/invoices/[id]",
        "/fulfillment/retail/invoices/[id]/edit",
        "/fulfillment/retail/invoices/new",
        "/fulfillment/retail/line-sheets/[id]",
        "/fulfillment/retail/line-sheets/[id]/edit",
        "/fulfillment/retail/line-sheets/new",
        "/fulfillment/retail/retailers/[id]",
        "/fulfillment/retail/settings",
      ].sort(),
    );
    for (const p of pages) expect(PAGE_RULES[p], p).toEqual({ kind: "admin" });
    expect(apis.length).toBe(21); // 15 Retail + 6 line sheet routes
    for (const a of apis) expect(API_RULES[a], a).toEqual({ kind: "admin" });
    expect(Object.keys(API_RULES).filter((k) => k.startsWith("/api/retail")).sort()).toEqual([...apis].sort());
    expect(apiRule("/api/retail/invoices/123e4567-e89b-42d3-a456-426614174000/pdf")).toEqual({ kind: "admin" });
    expect(pageRule("/fulfillment/retail/invoices/123e4567-e89b-42d3-a456-426614174000/edit")).toEqual({ kind: "admin" });
    expect(apiRule("/api/retail/line-sheets/123e4567-e89b-42d3-a456-426614174000/pdf")).toEqual({ kind: "admin" });
    expect(pageRule("/fulfillment/retail/line-sheets/123e4567-e89b-42d3-a456-426614174000/edit")).toEqual({ kind: "admin" });
  });

  it("non-admins get the forbidden page, even with every feature; Admins get in", () => {
    const user = { id: "00000000-0000-4000-8000-000000000009" } as never;
    const base = {
      userId: "u", accountId: "a", status: "active" as const, email: "staff1@example.test", firstName: "Sam", lastName: "Staff",
      roles: ["Everything"], fullName: "Sam Staff", active: true, isAdmin: false, features: new Set<string>(FEATURE_KEYS),
    };
    for (const p of pages) {
      expect(decidePage(p, { user, access: base, error: null }), p).toEqual({ kind: "forbidden" });
      expect(decidePage(p, { user, access: { ...base, isAdmin: true }, error: null }), p).toEqual({ kind: "allow" });
    }
  });
});

// guardApi for real (catalog + access_for_user), with a fake service-role client.
const fake = vi.hoisted(() => ({ isAdmin: false, features: [] as string[] }));
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: async () => ({ data: { user: { id: "00000000-0000-4000-8000-000000000009" } }, error: null }) },
    rpc: async () => ({
      data: { account_id: "a1", status: "active", first_name: "Sam", last_name: "Staff", email: "staff1@example.test", is_admin: fake.isAdmin, roles: ["Some role"], features: fake.features },
      error: null,
    }),
    from: () => {
      throw new Error("database not available in this test");
    },
  },
}));

import * as bootRoute from "@/app/api/retail/route";
import * as settingsRoute from "@/app/api/retail/settings/route";
import * as retailersRoute from "@/app/api/retail/retailers/route";
import * as retailerRoute from "@/app/api/retail/retailers/[retailerId]/route";
import * as archiveRoute from "@/app/api/retail/retailers/[retailerId]/archive/route";
import * as restoreRetailerRoute from "@/app/api/retail/retailers/[retailerId]/restore/route";
import * as pricesRoute from "@/app/api/retail/retailers/[retailerId]/prices/route";
import * as toolsRoute from "@/app/api/retail/retailers/[retailerId]/prices/tools/route";
import * as invoicesRoute from "@/app/api/retail/invoices/route";
import * as previewRoute from "@/app/api/retail/invoices/preview/route";
import * as checkOrderRoute from "@/app/api/retail/invoices/check-order/route";
import * as invoiceRoute from "@/app/api/retail/invoices/[invoiceId]/route";
import * as deleteRoute from "@/app/api/retail/invoices/[invoiceId]/delete/route";
import * as restoreRoute from "@/app/api/retail/invoices/[invoiceId]/restore/route";
import * as pdfRoute from "@/app/api/retail/invoices/[invoiceId]/pdf/route";

describe("Retail API responses", () => {
  const ID = "123e4567-e89b-42d3-a456-426614174000";
  const req = (p: string, method: "GET" | "POST", body = "{}") =>
    new Request(`http://localhost/api/retail${p}`, {
      method,
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: method === "POST" ? body : undefined,
    });
  const r = { params: Promise.resolve({ retailerId: ID }) };
  const i = { params: Promise.resolve({ invoiceId: ID }) };
  const all = () => [
    bootRoute.GET(req("", "GET")),
    settingsRoute.POST(req("/settings", "POST")),
    retailersRoute.POST(req("/retailers", "POST")),
    retailerRoute.GET(req(`/retailers/${ID}`, "GET"), r),
    retailerRoute.POST(req(`/retailers/${ID}`, "POST"), r),
    archiveRoute.POST(req(`/retailers/${ID}/archive`, "POST"), r),
    restoreRetailerRoute.POST(req(`/retailers/${ID}/restore`, "POST"), r),
    pricesRoute.POST(req(`/retailers/${ID}/prices`, "POST"), r),
    toolsRoute.POST(req(`/retailers/${ID}/prices/tools`, "POST"), r),
    invoicesRoute.GET(req("/invoices", "GET")),
    invoicesRoute.POST(req("/invoices", "POST")),
    previewRoute.POST(req("/invoices/preview", "POST")),
    checkOrderRoute.POST(req("/invoices/check-order", "POST")),
    invoiceRoute.GET(req(`/invoices/${ID}`, "GET"), i),
    invoiceRoute.POST(req(`/invoices/${ID}`, "POST"), i),
    deleteRoute.POST(req(`/invoices/${ID}/delete`, "POST"), i),
    restoreRoute.POST(req(`/invoices/${ID}/restore`, "POST"), i),
    pdfRoute.GET(req(`/invoices/${ID}/pdf`, "GET"), i),
  ];

  it("403 on every Retail route for a non-admin, even with every feature", async () => {
    fake.isAdmin = false;
    fake.features = [...FEATURE_KEYS];
    for (const res of await Promise.all(all())) expect(res.status).toBe(403);
  });

  it("Admins pass the guard", async () => {
    fake.isAdmin = true;
    fake.features = [];
    const res = await checkOrderRoute.POST(req("/invoices/check-order", "POST", JSON.stringify({ order_number: "" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ normalized: null, conflict: null, message: "Enter the Shopify order number." });
    const bad = await invoicesRoute.POST(req("/invoices", "POST", JSON.stringify({ invoice: {} })));
    expect(bad.status).toBe(400); // past the guard, refused by validation before any database call
    const body = await bad.json();
    expect(body.fields.order_number).toBe("Enter the Shopify order number.");
  });
});
