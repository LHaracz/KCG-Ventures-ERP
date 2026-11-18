// The Marketing & Sales sidebar regrouping and access. The only changes
// allowed: a new last BotanIQals group "Marketing & Sales" (Launch Pipeline,
// Prospecting, Marketing Hub, Retail, Sales Data, Sales Stats), with Sales
// Data, Sales Stats and Retail moved out of Fulfillment. URLs, feature keys,
// rules and role assignments of the moved pages don't change. Invented people
// and example.test addresses only.
import { describe, expect, it, vi } from "vitest";
import {
  ADMIN_ONLY_NOTE,
  ALL_SECTIONS,
  API_RULES,
  EMPLOYEES_ITEM,
  FEATURES,
  FEATURE_GROUPS,
  FEATURE_KEYS,
  PAGE_RULES,
  TOP_ITEMS,
  buildSidebar,
  navItemActive,
  previewSidebarLabels,
  type NavSection,
} from "@/lib/access/catalog";
import { decidePage } from "@/lib/access/server";
import { listAssignableEmployees } from "@/lib/growth/employees";

// The Admin sidebar recorded before this build.
const BEFORE: NavSection[] = [
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
          { href: "/fulfillment/retail", label: "Retail" },
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
];

const AFTER: NavSection[] = [
  {
    title: "BotanIQals",
    categories: [
      BEFORE[0].categories![0],
      BEFORE[0].categories![1],
      { title: "Fulfillment", items: BEFORE[0].categories![2].items.slice(0, 2) },
      BEFORE[0].categories![3],
      {
        title: "Marketing & Sales",
        items: [
          { href: "/growth/launches", label: "Launch Pipeline" },
          { href: "/growth/prospecting", label: "Prospecting" },
          { href: "/growth/marketing", label: "Marketing Hub" },
          { href: "/fulfillment/retail", label: "Retail" },
          { href: "/sales-data", label: "Sales Data" },
          { href: "/stats", label: "Sales Stats" },
        ],
      },
    ],
  },
  BEFORE[1],
];

const tree = (sections: NavSection[]) =>
  sections
    .flatMap((s) => [s.title, ...(s.categories ?? []).map((c) => `  ${c.title}: ${c.items.map((i) => i.label).join(", ")}`), ...(s.items ? [`  ${s.items.map((i) => i.label).join(", ")}`] : [])])
    .join("\n");
const leaves = (sections: NavSection[]) => sections.flatMap((s) => [...(s.categories ?? []).flatMap((c) => c.items), ...(s.items ?? [])]);
const groups = (features: string[]) =>
  Object.fromEntries((buildSidebar({ active: true, isAdmin: false, features: new Set(features) }).sections[0]?.categories ?? []).map((c) => [c.title, c.items.map((i) => i.label)]));

const WAREHOUSE = ["inventory.finished_products", "inventory.raw_materials", "inventory.purchase_orders", "fulfillment.orders", "fulfillment.pick_list", "compliance.sops", "compliance.logs", "compliance.coas"];
const PRODUCTION = ["production.calibration", "production.products_bom", "production.planner", "production.optimization", "production.formulation", "inventory.finished_products", "inventory.raw_materials", "inventory.purchase_orders", "compliance.sops", "compliance.logs", "compliance.coas"];

describe("sidebar regrouping", () => {
  it("Admin: before and after, with only the allowed moves", () => {
    console.log(`Admin sidebar BEFORE:\n${tree(BEFORE)}\n\nAdmin sidebar AFTER:\n${tree(ALL_SECTIONS)}`);
    const admin = buildSidebar({ active: true, isAdmin: true, features: new Set() });
    expect(admin.sections).toEqual(AFTER);
    expect(ALL_SECTIONS).toEqual(AFTER);
    // Every item that existed before still exists, with the same URL and label.
    const after = leaves(ALL_SECTIONS);
    for (const item of leaves(BEFORE)) expect(after, item.label).toContainEqual(item);
    expect(after.length).toBe(leaves(BEFORE).length + 3);
    expect(admin.top).toEqual(TOP_ITEMS.map(({ href, label }) => ({ href, label })));
    expect(admin.employees).toEqual({ href: EMPLOYEES_ITEM.href, label: EMPLOYEES_ITEM.label });
    expect(admin.sections[0].categories!.at(-1)!.title).toBe("Marketing & Sales");
  });

  it("Sales Data only: Marketing & Sales with Sales Data, and no Fulfillment group", () => {
    expect(groups(["fulfillment.sales_data"])).toEqual({ "Marketing & Sales": ["Sales Data"] });
    expect(groups(["fulfillment.stats"])).toEqual({ "Marketing & Sales": ["Sales Stats"] });
  });

  it("Fulfillments only: Fulfillment and no Marketing & Sales", () => {
    expect(groups(["fulfillment.orders"])).toEqual({ Fulfillment: ["Fulfillments"] });
  });

  it("the seeded Warehouse and Production roles see no Marketing & Sales group, and nothing else changed for them", () => {
    expect(groups(WAREHOUSE)).toEqual({ Inventory: ["Finished Products Inventory", "Raw Materials", "Procurement"], Fulfillment: ["Fulfillments", "Pick List"], Compliance: ["SOPs", "Logs", "COAs"] });
    expect(Object.keys(groups(PRODUCTION))).toEqual(["Production", "Inventory", "Compliance"]);
    expect(Object.keys(groups([...WAREHOUSE, ...PRODUCTION]))).toEqual(["Production", "Inventory", "Fulfillment", "Compliance"]);
  });

  it("Pick List + Marketing Hub: both groups, each with its own items", () => {
    expect(groups(["fulfillment.pick_list", "growth.marketing"])).toEqual({ Fulfillment: ["Pick List"], "Marketing & Sales": ["Marketing Hub"] });
  });

  it("each new item shows only with its own feature; Retail only for Admins", () => {
    expect(groups(["growth.launches"])).toEqual({ "Marketing & Sales": ["Launch Pipeline"] });
    expect(groups(["growth.prospecting"])).toEqual({ "Marketing & Sales": ["Prospecting"] });
    expect(groups(["growth.marketing"])).toEqual({ "Marketing & Sales": ["Marketing Hub"] });
    const everything = groups([...FEATURE_KEYS]);
    expect(everything["Marketing & Sales"]).toEqual(["Launch Pipeline", "Prospecting", "Marketing Hub", "Sales Data", "Sales Stats"]);
    expect(everything.Fulfillment).toEqual(["Fulfillments", "Pick List"]);
    expect(buildSidebar({ active: false, isAdmin: true, features: new Set() }).sections).toEqual([]);
  });

  it("every other single feature shows the same item as before", () => {
    for (const key of FEATURE_KEYS.filter((k) => !k.startsWith("growth."))) {
      const sb = buildSidebar({ active: true, isAdmin: false, features: new Set([key]) });
      const items = leaves(sb.sections);
      expect(items, key).toHaveLength(key === "fulfillment.setup" ? 0 : 1);
      if (items.length) expect(leaves(BEFORE), key).toContainEqual(items[0]);
    }
  });

  it("moved pages keep their URLs, feature keys and rules", () => {
    expect(PAGE_RULES["/sales-data"]).toEqual({ kind: "feature", features: ["fulfillment.sales_data"] });
    expect(PAGE_RULES["/stats"]).toEqual({ kind: "feature", features: ["fulfillment.stats"] });
    expect(PAGE_RULES["/fulfillment/retail"]).toEqual({ kind: "admin" });
    expect(API_RULES["/api/sales-data/import"]).toEqual({ kind: "feature", features: ["fulfillment.sales_data"] });
    expect(API_RULES["/api/retail"]).toEqual({ kind: "admin" });
    expect(FEATURES.find((f) => f.key === "fulfillment.sales_data")).toMatchObject({ label: "Sales Data", description: "Sales imports, CSV upload, variant mapping and unmapped items." });
    expect(FEATURES.find((f) => f.key === "fulfillment.stats")).toMatchObject({ label: "Sales Stats", description: "Sales statistics." });
  });

  it("highlighting: each page lights up its own item under its group", () => {
    const cases: Array<[string, string]> = [
      ["/growth/launches", "/growth/launches"],
      ["/growth/launches", "/growth/launches/123e4567-e89b-42d3-a456-426614174000"],
      ["/growth/prospecting", "/growth/prospecting/leads/123e4567-e89b-42d3-a456-426614174000"],
      ["/growth/prospecting", "/growth/prospecting/trips/123e4567-e89b-42d3-a456-426614174000"],
      ["/growth/marketing", "/growth/marketing"],
      ["/fulfillment/retail", "/fulfillment/retail/invoices/new"],
      ["/sales-data", "/sales-data"],
      ["/stats", "/stats"],
    ];
    for (const [href, path] of cases) {
      const active = leaves(ALL_SECTIONS).filter((i) => navItemActive(i.href, path));
      expect(active.map((i) => i.href), path).toEqual([href]);
    }
    expect(navItemActive("/growth/launches", "/growth/launchesx")).toBe(false);
  });
});

describe("role editor", () => {
  it("Marketing & Sales after Compliance and before MiniLeaf; every feature exactly once", () => {
    expect(FEATURE_GROUPS).toEqual(["Production", "Inventory", "Fulfillment", "Compliance", "Marketing & Sales", "MiniLeaf"]);
    const shown = FEATURE_GROUPS.flatMap((g) => FEATURES.filter((f) => f.group === g && f.assignable).map((f) => f.key));
    expect(shown.sort()).toEqual([...FEATURE_KEYS].sort());
    expect(new Set(shown).size).toBe(shown.length);
    expect(FEATURES.filter((f) => f.group === "Marketing & Sales").map((f) => f.key)).toEqual([
      "growth.launches",
      "growth.prospecting",
      "growth.marketing",
      "fulfillment.sales_data",
      "fulfillment.stats",
    ]);
    expect(FEATURES.filter((f) => f.group === "Fulfillment").map((f) => f.key)).toEqual(["fulfillment.orders", "fulfillment.pick_list", "fulfillment.setup"]);
    for (const f of FEATURES.filter((x) => x.key.startsWith("growth."))) expect(f.description.length).toBeGreaterThan(10);
    expect(previewSidebarLabels(["growth.marketing", "fulfillment.stats"])).toEqual(["BotanIQals › Marketing & Sales › Marketing Hub", "BotanIQals › Marketing & Sales › Sales Stats"]);
    expect(previewSidebarLabels(FEATURE_KEYS).some((l) => l.endsWith("› Retail"))).toBe(false);
    expect(ADMIN_ONLY_NOTE).toMatch(/line sheets/);
    expect(ADMIN_ONLY_NOTE).toMatch(/approving, rejecting or retiring marketing claims/);
  });
});

describe("pages and helpers", () => {
  const user = { id: "00000000-0000-4000-8000-000000000009" } as never;
  const base = {
    userId: "u", accountId: "a", status: "active" as const, email: "staff1@example.test", firstName: "Sam", lastName: "Staff",
    roles: ["Some role"], fullName: "Sam Staff", active: true, isAdmin: false, features: new Set<string>(),
  };
  const pages: Array<[string, string]> = [
    ["/growth/launches", "growth.launches"],
    ["/growth/launches/[id]", "growth.launches"],
    ["/growth/prospecting", "growth.prospecting"],
    ["/growth/prospecting/leads/[id]", "growth.prospecting"],
    ["/growth/prospecting/trips/[id]", "growth.prospecting"],
    ["/growth/marketing", "growth.marketing"],
  ];
  it("each new page needs its own feature (forbidden otherwise)", () => {
    for (const [p, f] of pages) {
      expect(decidePage(p, { user, access: { ...base, features: new Set(FEATURE_KEYS.filter((k) => k !== f)) }, error: null }), p).toEqual({ kind: "forbidden" });
      expect(decidePage(p, { user, access: { ...base, features: new Set([f]) }, error: null }), p).toEqual({ kind: "allow" });
      expect(decidePage(p, { user, access: { ...base, isAdmin: true }, error: null }), p).toEqual({ kind: "allow" });
    }
    for (const p of ["/fulfillment/retail/line-sheets/new", "/fulfillment/retail/line-sheets/[id]"]) {
      expect(decidePage(p, { user, access: { ...base, features: new Set(FEATURE_KEYS) }, error: null })).toEqual({ kind: "forbidden" });
    }
  });

  it("listAssignableEmployees: active people only, id and name only", async () => {
    const calls: string[] = [];
    const db = {
      from: (t: string) => ({
        select: (cols: string) => {
          calls.push(`${t}:${cols}`);
          return {
            eq: async (col: string, val: string) => {
              calls.push(`${col}=${val}`);
              return { data: [{ id: "2", first_name: "Zoe", last_name: "Example" }, { id: "1", first_name: "Ada", last_name: "Example" }, { id: "3", first_name: null, last_name: null }], error: null };
            },
          };
        },
      }),
    };
    const list = await listAssignableEmployees(db);
    expect(list).toEqual([{ id: "1", name: "Ada Example" }, { id: "3", name: "Unnamed employee" }, { id: "2", name: "Zoe Example" }]);
    expect(calls).toEqual(["employee_accounts:id, first_name, last_name, status", "status=active"]);
    expect(JSON.stringify(list)).not.toMatch(/@|role/i);
  });
});

// guardApi for real, with a fake service-role client.
const fake = vi.hoisted(() => ({ isAdmin: false, features: [] as string[] }));
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: async () => ({ data: { user: { id: "00000000-0000-4000-8000-000000000009" } }, error: null }) },
    rpc: async () => ({
      data: { account_id: "a1", status: "active", first_name: "Sam", last_name: "Staff", email: "staff1@example.test", is_admin: fake.isAdmin, roles: ["Some role"], features: fake.features },
      error: null,
    }),
    from: () => ({
      select: () => ({ eq: async () => ({ data: [{ id: "1", first_name: "Ada", last_name: "Example" }], error: null }) }),
    }),
  },
}));
import * as employeesRoute from "@/app/api/growth/employees/route";

describe("employees route", () => {
  const req = () => new Request("http://localhost/api/growth/employees", { headers: { authorization: "Bearer test-token" } });
  it("403 without a Marketing & Sales feature, 200 with any of the three", async () => {
    fake.features = ["fulfillment.sales_data", "fulfillment.stats", "fulfillment.orders"];
    expect((await employeesRoute.GET(req())).status).toBe(403);
    for (const f of ["growth.launches", "growth.prospecting", "growth.marketing"]) {
      fake.features = [f];
      const res = await employeesRoute.GET(req());
      expect(res.status, f).toBe(200);
      expect(await res.json()).toEqual({ employees: [{ id: "1", name: "Ada Example" }] });
    }
  });
});
