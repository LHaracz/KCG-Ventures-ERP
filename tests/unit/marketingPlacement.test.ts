// Placement of the Ad Library build: everything lives inside the Marketing
// Hub page. The tab order (Settings last, Admin only), the older tabs' URL
// keys, every new API route under /api/growth/marketing with the hub's
// feature (Admin-only for the avoid list and the Raw Materials names), no new
// pages, the sidebar exactly as recorded before the build, and "Marketing
// Hub" staying highlighted.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { API_RULES, PAGE_RULES, apiRule, buildSidebar, navItemActive, pageRule } from "@/lib/access/catalog";
import { MARKETING_TABS, marketingTabsFor } from "@/lib/growth/marketingTabs";

const admin = { active: true, isAdmin: true, features: new Set<string>() };
const marketer = { active: true, isAdmin: false, features: new Set<string>(["growth.marketing"]) };

describe("Marketing Hub tabs", () => {
  it("are in the agreed order, with Settings last for Admins only", () => {
    expect(marketingTabsFor(false).map((t) => t.label)).toEqual(["Calendar", "Ad Library", "Pillars", "Assets", "Claims", "Products", "Templates", "Best Times"]);
    expect(marketingTabsFor(true).map((t) => t.label)).toEqual(["Calendar", "Ad Library", "Pillars", "Assets", "Claims", "Products", "Templates", "Best Times", "Settings"]);
  });
  it("the older tabs keep their URL keys", () => {
    const keys = Object.fromEntries(marketingTabsFor(true).map((t) => [t.label, t.key]));
    expect(keys).toMatchObject({ Calendar: "calendar", Assets: "assets", Claims: "claims", Products: "products", Templates: "templates", Settings: "settings" });
    expect(MARKETING_TABS.map((t) => t.key)).toEqual(["calendar", "library", "pillars", "assets", "claims", "products", "templates", "best-times"]);
  });
});

function walk(dir: string, file: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, file));
    else if (name === file) out.push(p);
  }
  return out;
}
const appDir = path.join(process.cwd(), "src/app");
const toRoute = (f: string) => `/${path.relative(appDir, path.dirname(f)).split(path.sep).join("/")}`;

describe("routes", () => {
  const marketingApis = walk(path.join(appDir, "api/growth/marketing"), "route.ts").map(toRoute);

  it("every Marketing Hub API route is registered: the hub's feature, or Admin only", () => {
    for (const r of marketingApis) expect(API_RULES[r], r).toBeDefined();
    const admins = marketingApis.filter((r) => API_RULES[r].kind === "admin").sort();
    expect(admins).toEqual([
      "/api/growth/marketing/avoid-phrases",
      "/api/growth/marketing/avoid-phrases/[phraseId]",
      "/api/growth/marketing/claims/[claimId]/review",
      "/api/growth/marketing/ingredient-tags/raw-materials",
      "/api/growth/marketing/risky-words",
      "/api/growth/marketing/risky-words/[wordId]",
    ]);
    for (const r of marketingApis.filter((x) => !admins.includes(x))) expect(API_RULES[r], r).toEqual({ kind: "feature", features: ["growth.marketing"] });
  });

  it("the new routes are all under /api/growth/marketing (no other growth routes were added)", () => {
    const added = ["pillars", "series", "library", "closing-lines", "ingredient-tags", "windows", "rhythm", "avoid-phrases"];
    for (const seg of added) expect(marketingApis.some((r) => r.startsWith(`/api/growth/marketing/${seg}`)), seg).toBe(true);
    const growthApis = walk(path.join(appDir, "api/growth"), "route.ts").map(toRoute).filter((r) => !r.startsWith("/api/growth/marketing"));
    for (const r of growthApis) expect(/^\/api\/growth\/(employees|launches|prospecting)/.test(r), r).toBe(true);
  });

  it("no new pages: the Marketing Hub is still one page", () => {
    const pages = walk(path.join(appDir, "growth"), "page.tsx").map(toRoute).sort();
    expect(pages).toEqual(["/growth/launches", "/growth/launches/[id]", "/growth/marketing", "/growth/prospecting", "/growth/prospecting/leads/[id]", "/growth/prospecting/trips/[id]"]);
    expect(PAGE_RULES["/growth/marketing"]).toEqual({ kind: "feature", features: ["growth.marketing"] });
    expect(pageRule("/growth/marketing")).toEqual({ kind: "feature", features: ["growth.marketing"] });
    expect(apiRule("/api/growth/marketing/library/123e4567-e89b-42d3-a456-426614174000/schedule")).toEqual({ kind: "feature", features: ["growth.marketing"] });
  });

  it("no Dashboard card names the Ad Library", () => {
    const dash = readFileSync(path.join(appDir, "client-page.tsx"), "utf8");
    expect(dash).not.toMatch(/Ad Library|premade|Best Times|LibraryCalendar|AssetLibrary/);
  });
});

describe("sidebar", () => {
  it("is exactly as recorded before this build (Admin)", () => {
    const s = buildSidebar(admin);
    const flat = {
      top: s.top.map((i) => i.href),
      employees: s.employees?.href ?? null,
      sections: s.sections.map((sec) => ({
        title: sec.title,
        categories: (sec.categories ?? []).map((c) => ({ title: c.title, items: c.items.map((i) => `${i.href}|${i.label}`) })),
        items: (sec.items ?? []).map((i) => `${i.href}|${i.label}`),
      })),
    };
    expect(flat).toEqual({
      top: ["/", "/schedule", "/notifications", "/settings/notifications"],
      employees: "/employees",
      sections: [
        {
          title: "BotanIQals",
          categories: [
            { title: "Production", items: ["/calibration|Freeze Dryer Calibration", "/products|Products & BOM", "/formulation|Formulation", "/cycles|Production Cycles & Planner", "/production-optimization|Production Optimization"] },
            { title: "Inventory", items: ["/finished-products-inventory|Finished Products Inventory", "/inventory|Raw Materials", "/inventory/procurement|Procurement"] },
            { title: "Fulfillment", items: ["/fulfillments|Fulfillments", "/fulfillments/pick-list|Pick List"] },
            { title: "Compliance", items: ["/compliance/sops|SOPs", "/compliance/logs|Logs", "/compliance/coas|COAs"] },
            { title: "Marketing & Sales", items: ["/growth/launches|Launch Pipeline", "/growth/prospecting|Prospecting", "/growth/marketing|Marketing Hub", "/fulfillment/retail|Retail", "/sales-data|Sales Data", "/stats|Sales Stats"] },
          ],
          items: [],
        },
        { title: "MiniLeaf", categories: [], items: ["/microgreens|Microgreens Guide", "/yield|Yield Logging", "/microgreen-optimization|Microgreens Optimization"] },
      ],
    });
  });

  it("a marketer sees only the Marketing Hub in Marketing & Sales, and it stays highlighted on the hub's URLs", () => {
    const s = buildSidebar(marketer);
    expect(s.sections.flatMap((sec) => (sec.categories ?? []).flatMap((c) => c.items.map((i) => i.href)))).toEqual(["/growth/marketing"]);
    for (const p of ["/growth/marketing", "/growth/marketing/library/123"]) expect(navItemActive("/growth/marketing", p), p).toBe(true);
  });
});
