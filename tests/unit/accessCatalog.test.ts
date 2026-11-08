/* eslint-disable @typescript-eslint/no-explicit-any */
// Feature catalog, sidebar, page and API decisions, the route registry check,
// and the password policy. Invented data only.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ALL_SECTIONS,
  API_RULES,
  FEATURE_KEYS,
  PAGE_RULES,
  apiRule,
  buildSidebar,
  pageRule,
  previewSidebarLabels,
  type AccessSummary,
} from "@/lib/access/catalog";
import { checkPassword, passwordProblem } from "@/lib/access/passwordPolicy";
import { checkAccessRegistry } from "../../scripts/lib/accessRegistry";

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/supabaseServer", () => ({ createServerSupabase: vi.fn() }));
const admin = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/supabaseAdmin", () => ({
  get supabaseAdmin() {
    return admin.client;
  },
}));

const roleFeatures = {
  warehouse: ["inventory.finished_products", "inventory.raw_materials", "inventory.purchase_orders", "fulfillment.orders", "fulfillment.pick_list", "compliance.sops", "compliance.logs", "compliance.coas"],
  production: ["production.calibration", "production.products_bom", "production.planner", "production.optimization", "production.formulation", "inventory.finished_products", "inventory.raw_materials", "inventory.purchase_orders", "compliance.sops", "compliance.logs", "compliance.coas"],
};
const summary = (features: string[], isAdmin = false, active = true): AccessSummary => ({ active, isAdmin, features: new Set(features) });

// The sidebar exactly as it was before this build (Navigation.tsx at e36e582).
const SIDEBAR_BEFORE = {
  top: [
    { href: "/", label: "Dashboard" },
    { href: "/schedule", label: "Schedule" },
    { href: "/notifications", label: "Alerts" },
    { href: "/settings/notifications", label: "Notification Settings" },
  ],
  sections: [
    {
      title: "BotanIQals",
      categories: [
        { title: "Production", items: [
          { href: "/calibration", label: "Freeze Dryer Calibration" },
          { href: "/products", label: "Products & BOM" },
          { href: "/formulation", label: "Formulation" },
          { href: "/cycles", label: "Production Cycles & Planner" },
          { href: "/production-optimization", label: "Production Optimization" },
        ] },
        { title: "Inventory", items: [
          { href: "/finished-products-inventory", label: "Finished Products Inventory" },
          { href: "/inventory", label: "Raw Materials" },
          { href: "/inventory/purchase-orders", label: "Purchase Orders" },
        ] },
        { title: "Fulfillment", items: [
          { href: "/fulfillments", label: "Fulfillments" },
          { href: "/fulfillments/pick-list", label: "Pick List" },
          { href: "/sales-data", label: "Sales Data" },
          { href: "/stats", label: "Sales Stats" },
        ] },
        { title: "Compliance", items: [
          { href: "/compliance/sops", label: "SOPs" },
          { href: "/compliance/logs", label: "Logs" },
          { href: "/compliance/coas", label: "COAs" },
        ] },
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
  it("an Admin sees exactly today's sidebar plus Employees", () => {
    const sb = buildSidebar(summary([], true));
    expect(sb.top).toEqual(SIDEBAR_BEFORE.top);
    expect(sb.sections).toEqual(SIDEBAR_BEFORE.sections);
    expect(sb.employees).toEqual({ href: "/employees", label: "Employees" });
    expect(ALL_SECTIONS).toEqual(SIDEBAR_BEFORE.sections);
  });

  it("Warehouse Operations: no Production group, no MiniLeaf, sees COAs, no Notification Settings or Employees", () => {
    const sb = buildSidebar(summary(roleFeatures.warehouse));
    expect(sb.top.map((i) => i.label)).toEqual(["Dashboard", "Schedule", "Alerts"]);
    expect(sb.employees).toBeNull();
    expect(sb.sections.map((s) => s.title)).toEqual(["BotanIQals"]);
    const groups = sb.sections[0].categories!;
    expect(groups.map((g) => g.title)).toEqual(["Inventory", "Fulfillment", "Compliance"]);
    expect(groups[1].items.map((i) => i.label)).toEqual(["Fulfillments", "Pick List"]);
    expect(groups[2].items.map((i) => i.label)).toEqual(["SOPs", "Logs", "COAs"]);
  });

  it("Production Operations: no Fulfillment group, no MiniLeaf", () => {
    const sb = buildSidebar(summary(roleFeatures.production));
    expect(sb.sections.map((s) => s.title)).toEqual(["BotanIQals"]);
    expect(sb.sections[0].categories!.map((g) => g.title)).toEqual(["Production", "Inventory", "Compliance"]);
    expect(sb.sections[0].categories![0].items).toHaveLength(5);
  });

  it("both roles together: the union, still no Sales Data, Sales Stats or MiniLeaf", () => {
    const sb = buildSidebar(summary([...roleFeatures.warehouse, ...roleFeatures.production]));
    expect(sb.sections[0].categories!.map((g) => g.title)).toEqual(["Production", "Inventory", "Fulfillment", "Compliance"]);
    expect(sb.sections[0].categories![2].items.map((i) => i.label)).toEqual(["Fulfillments", "Pick List"]);
    expect(sb.sections.some((s) => s.title === "MiniLeaf")).toBe(false);
  });

  it("no empty groups or headers; MiniLeaf-only shows only MiniLeaf", () => {
    const sb = buildSidebar(summary(["minileaf.yield_logging"]));
    expect(sb.sections).toEqual([{ title: "MiniLeaf", items: [{ href: "/yield", label: "Yield Logging" }] }]);
    expect(buildSidebar(summary([])).sections).toEqual([]);
  });

  it("deactivated or unknown people get no sidebar items", () => {
    expect(buildSidebar(summary(roleFeatures.warehouse, false, false))).toEqual({ top: [], employees: null, sections: [] });
    expect(buildSidebar(null)).toEqual({ top: [], employees: null, sections: [] });
  });

  it("role preview lists what a role would show", () => {
    expect(previewSidebarLabels(["compliance.coas"])).toEqual(["BotanIQals › Compliance › COAs"]);
  });
});

describe("rules", () => {
  it("neither seeded role reaches the log template builder, Employees or Notification Settings", () => {
    for (const route of ["/compliance/logs/settings", "/employees", "/settings/notifications"]) {
      expect(pageRule(route).kind).toBe("admin");
    }
    expect(apiRule("/api/admin/employees").kind).toBe("admin");
  });

  it("unregistered API paths are Admin only (fail closed)", () => {
    expect(apiRule("/api/not-a-real-route").kind).toBe("admin");
  });

  it("every feature in a rule is a known feature", () => {
    for (const rule of [...Object.values(PAGE_RULES), ...Object.values(API_RULES)]) {
      if (rule.kind === "feature") for (const f of rule.features) expect(FEATURE_KEYS).toContain(f);
    }
  });
});

describe("decidePage", () => {
  const user = { id: "u1" } as any;
  const access = (over: Record<string, unknown> = {}) =>
    ({ userId: "u1", accountId: "a1", status: "active", email: "x@example.test", firstName: "Jo", lastName: "Doe", roles: [], fullName: "Jo Doe", active: true, isAdmin: false, features: new Set<string>(), ...over }) as any;

  it("covers sign-in, no access, profile, forbidden and allow", async () => {
    const { decidePage } = await import("@/lib/access/server");
    expect(decidePage("/login", { user: null, access: null, error: null }).kind).toBe("allow");
    expect(decidePage("/cycles", { user: null, access: null, error: null }).kind).toBe("login");
    expect(decidePage("/cycles", { user, access: null, error: null }).kind).toBe("no_access");
    expect(decidePage("/cycles", { user, access: null, error: "db down" }).kind).toBe("forbidden");
    expect(decidePage("/cycles", { user, access: access({ status: "deactivated", active: false }), error: null }).kind).toBe("no_access");
    expect(decidePage("/cycles", { user, access: access({ fullName: null }), error: null }).kind).toBe("complete_profile");
    expect(decidePage("/cycles", { user, access: access(), error: null }).kind).toBe("forbidden");
    expect(decidePage("/cycles", { user, access: access({ features: new Set(["production.planner"]) }), error: null }).kind).toBe("allow");
    expect(decidePage("/employees", { user, access: access({ features: new Set(FEATURE_KEYS) }), error: null }).kind).toBe("forbidden");
    expect(decidePage("/employees", { user, access: access({ isAdmin: true }), error: null }).kind).toBe("allow");
  });
});

describe("guardApi", () => {
  const rpcRow = vi.fn();
  beforeEach(() => {
    rpcRow.mockReset();
    admin.client = {
      auth: { getUser: vi.fn(async (t: string) => (t === "good" ? { data: { user: { id: "u1" } }, error: null } : { data: { user: null }, error: { message: "bad" } })) },
      rpc: vi.fn(async () => ({ data: rpcRow(), error: null })),
    };
  });
  const req = (p: string, token?: string) => new Request(`http://localhost${p}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const row = (features: string[], status = "active", is_admin = false) => ({ account_id: "a1", status, first_name: "Jo", last_name: "Doe", email: "jo@example.test", is_admin, roles: [], features });

  it("401 without a valid sign-in", async () => {
    const { guardApi } = await import("@/lib/access/api");
    expect((await guardApi(req("/api/fulfillments/orders")))!.status).toBe(401);
    expect((await guardApi(req("/api/fulfillments/orders", "nope")))!.status).toBe(401);
  });

  it("403 without the feature, deactivated, or when access can't be read; allowed with it", async () => {
    const { guardApi, callerOf } = await import("@/lib/access/api");
    rpcRow.mockReturnValue(row(["compliance.sops"]));
    expect((await guardApi(req("/api/fulfillments/orders", "good")))!.status).toBe(403);
    rpcRow.mockReturnValue(row(["fulfillment.orders"], "deactivated"));
    expect((await guardApi(req("/api/fulfillments/orders", "good")))!.status).toBe(403);
    rpcRow.mockImplementation(() => {
      throw new Error("db down");
    });
    expect((await guardApi(req("/api/fulfillments/orders", "good")))!.status).toBe(403);
    rpcRow.mockReset();
    rpcRow.mockReturnValue(row(["fulfillment.orders"]));
    const r = req("/api/fulfillments/orders", "good");
    expect(await guardApi(r)).toBeNull();
    expect(callerOf(r).access.fullName).toBe("Jo Doe");
  });

  it("admin routes need the Admin role even with every feature", async () => {
    const { guardApi } = await import("@/lib/access/api");
    rpcRow.mockReturnValue(row(FEATURE_KEYS));
    expect((await guardApi(req("/api/admin/employees", "good")))!.status).toBe(403);
    rpcRow.mockReturnValue(row([], "active", true));
    expect(await guardApi(req("/api/admin/employees", "good"))).toBeNull();
  });
});

describe("route registry check", () => {
  const mk = (files: Record<string, string>) => {
    const dir = mkdtempSync(path.join(tmpdir(), "reg-"));
    for (const [f, body] of Object.entries(files)) {
      const p = path.join(dir, "src", "app", f);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, body);
    }
    return path.join(dir, "src");
  };
  const guarded = `export async function GET(request: Request) {\n  const denied = await guardApi(request); if (denied) return denied;\n  return new Response("ok");\n}\n`;

  it("passes for a registered, guarded route", () => {
    const src = mk({ "api/things/route.ts": guarded });
    expect(checkAccessRegistry(src, {}, { "/api/things": { kind: "admin" } })).toEqual([]);
  });

  it("fails on an unregistered route and on a handler without the guard", () => {
    const src = mk({
      "api/things/route.ts": guarded,
      "api/open/route.ts": `export async function GET() {\n  return new Response("ok");\n}\n`,
    });
    const problems = checkAccessRegistry(src, {}, { "/api/open": { kind: "admin" } });
    expect(problems.some((p) => p.file.endsWith("api/things/route.ts"))).toBe(true);
    expect(problems.some((p) => p.file.endsWith("api/open/route.ts"))).toBe(true);
  });

  it("fails on an unregistered page", () => {
    const src = mk({ "new-thing/page.tsx": `export default async function P() {\n  const g = await guardPage("/new-thing");\n  return null;\n}\n` });
    expect(checkAccessRegistry(src, {}, {}).length).toBeGreaterThan(0);
  });
});

describe("password policy", () => {
  it("needs 11+ characters with upper, lower, number and special", () => {
    expect(passwordProblem("Short1!")).not.toBeNull();
    expect(passwordProblem("alllowercase1!")).not.toBeNull();
    expect(passwordProblem("ALLUPPERCASE1!")).not.toBeNull();
    expect(passwordProblem("NoNumbersHere!")).not.toBeNull();
    expect(passwordProblem("NoSpecials123")).not.toBeNull();
    expect(passwordProblem("Good-Passw0rd")).toBeNull();
    expect(passwordProblem("A1!" + "a".repeat(80))).not.toBeNull();
    expect(passwordProblem(undefined)).not.toBeNull();
    expect(checkPassword("Good-Passw0rd").every((c) => c.ok)).toBe(true);
  });
});
