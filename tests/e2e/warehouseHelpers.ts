/**
 * Throwaway data for the picking / shipping browser tests and the real-
 * database specs. Everything is invented and tagged "[TEST]": products,
 * presets, variant mappings, staging boxes (is_test) and orders seeded into
 * fulfillment_orders_cache with ids "TEST-<tag>-n". Nothing calls Shopify or
 * EasyPost, and cleanup() removes it all (order_events / assignments through
 * the service-role-only fulfillment_test_cleanup()).
 *
 * These tests must run against a dev Supabase project or a local
 * `supabase start`, never production: assertDevDatabase() stops the run
 * otherwise.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";
import { admin } from "./helpers";
import { sizedPresets, suggestPackage, type PackagingPresetInput, type PackagingRuleInput } from "../../src/lib/packagingEngine";

export const PRODUCTION_PROJECT_REF = "ttfshzqopxwijdtpvgye";

export function assertDevDatabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!url) throw new Error("Set NEXT_PUBLIC_SUPABASE_URL to a dev project or local Supabase.");
  if (url.includes(PRODUCTION_PROJECT_REF)) {
    throw new Error("Refusing to run: NEXT_PUBLIC_SUPABASE_URL points at production. Use a dev project or `supabase start`.");
  }
  if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    throw new Error("Set NEXT_PUBLIC_SUPABASE_ANON_KEY for the same dev project (the browser uses it).");
  }
}

/** After login: the browser's Supabase session must belong to the dev project too. */
export async function assertBrowserOnDevDatabase(page: Page) {
  const keys: string[] = await page.evaluate(() => Object.keys(localStorage));
  const authKey = keys.find((k) => k.endsWith("-auth-token")) ?? "";
  if (!authKey || authKey.includes(PRODUCTION_PROJECT_REF)) {
    throw new Error(
      `Refusing to continue: the app in the browser is using ${authKey || "an unknown"} Supabase project. Start the dev server with the dev NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY.`,
    );
  }
}

export function anonClient(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false },
  });
}

const must = <T,>(r: { data: T; error: { message: string } | null }, what: string): NonNullable<T> => {
  if (r.error || r.data === null || r.data === undefined) throw new Error(`${what}: ${r.error?.message ?? "no data"}`);
  return r.data as NonNullable<T>;
};

export type WarehouseTestData = {
  tag: string;
  products: Record<"gum" | "spray" | "paste", { id: string; name: string; lineitem: string }>;
  presets: Record<"mailer" | "small" | "big", { id: string; nickname: string; maxPoints: number }>;
  boxes: Array<{ id: string; label: string; number: number }>;
  orders: Array<{ id: string; name: string; lineItems: Array<{ name: string; quantity: number }> }>;
};

/**
 * Orders (oldest first):
 *   1: 2 Gum                -> smallest preset by points
 *   2: 2 Gum + 1 Spray      -> Spray's minimum (test Small) or larger
 *   3: 1 Paste + 1 Gum
 *   4: an unmapped line item -> Needs Review
 *   5: 2 Gum (for the race test)
 *   6: 2 Gum (for the race test)
 */
export async function seedWarehouse(userId: string): Promise<WarehouseTestData> {
  assertDevDatabase();
  const db = admin();
  const tag = Math.random().toString(36).slice(2, 7);
  // Max points unlikely to collide with real presets (they must be unique).
  const salt = (Math.floor(Math.random() * 80) + 10) / 1000; // 0.010..0.089
  const presetDefs = {
    mailer: { nickname: `[TEST] Mailer ${tag}`, maxPoints: Number((4 + salt).toFixed(3)) },
    small: { nickname: `[TEST] Small ${tag}`, maxPoints: Number((10 + salt).toFixed(3)) },
    big: { nickname: `[TEST] Big ${tag}`, maxPoints: Number((25 + salt).toFixed(3)) },
  } as const;
  const presets = {} as WarehouseTestData["presets"];
  for (const [key, def] of Object.entries(presetDefs) as Array<[keyof typeof presetDefs, (typeof presetDefs)[keyof typeof presetDefs]]>) {
    const row = must(
      await db
        .from("package_presets")
        .insert({ user_id: userId, nickname: def.nickname, length_in: 8, width_in: 6, height_in: 2, tare_weight_oz: 1, max_points: Number(def.maxPoints.toFixed(2)) })
        .select("id, max_points")
        .single(),
      `preset ${key}`,
    ) as { id: string; max_points: number };
    presets[key] = { id: row.id, nickname: def.nickname, maxPoints: Number(row.max_points) };
  }

  const productDefs = { gum: 1, spray: 1, paste: 2 } as const;
  const products = {} as WarehouseTestData["products"];
  for (const [key, points] of Object.entries(productDefs) as Array<[keyof typeof productDefs, number]>) {
    const name = `[TEST] ${key[0].toUpperCase()}${key.slice(1)} ${tag}`;
    const p = must(
      await db.from("products").insert({ name, unit: "unit", is_microgreen: false, sale_price_per_unit: 0, user_id: userId }).select("id").single(),
      `product ${key}`,
    ) as { id: string };
    const lineitem = `${name} - Default`;
    must(
      await db.from("variant_component_map").insert({ lineitem_name: lineitem, business: "botaniqals", components: [{ product_id: p.id, qty_per_unit: 1 }] }).select("id"),
      `mapping ${key}`,
    );
    must(
      await db
        .from("product_packaging_rules")
        .insert({ product_id: p.id, points, min_package_id: key === "spray" ? presets.small.id : null })
        .select("id"),
      `rule ${key}`,
    );
    products[key] = { id: p.id, name, lineitem };
  }

  const boxes: WarehouseTestData["boxes"] = [];
  const base = 800000 + Math.floor(Math.random() * 90000) * 10;
  for (let i = 1; i <= 6; i++) {
    const b = must(await db.from("staging_boxes").insert({ box_number: base + i, is_test: true }).select("id, label, box_number").single(), "box") as any;
    boxes.push({ id: b.id, label: b.label, number: b.box_number });
  }

  const li = (k: keyof WarehouseTestData["products"], quantity: number) => ({ name: products[k].lineitem, quantity });
  const orderDefs = [
    [li("gum", 2)],
    [li("gum", 2), li("spray", 1)],
    [li("paste", 1), li("gum", 1)],
    [{ name: `[TEST] Unmapped Thing ${tag}`, quantity: 1 }],
    [li("gum", 2)],
    [li("gum", 2)],
  ];
  const orders = orderDefs.map((lineItems, i) => ({ id: `TEST-${tag}-${i + 1}`, name: `[TEST] #${tag}-${i + 1}`, lineItems }));
  must(
    await db
      .from("fulfillment_orders_cache")
      .insert(
        orders.map((o, i) => ({
          shopify_order_id: o.id,
          source: "test",
          payload: {
            orderId: o.id,
            name: o.name,
            // Old dates so they sort first on the Pick List.
            createdAt: new Date(Date.UTC(2020, 0, 1 + i, 15)).toISOString(),
            customerName: `[TEST] Customer ${i + 1}`,
            itemCount: o.lineItems.reduce((s, l) => s + l.quantity, 0),
            totalProductWeightOz: 3 + i,
            totalPrice: 10 + i,
            currencyCode: "USD",
            lineItems: o.lineItems,
          },
        })),
      )
      .select("shopify_order_id"),
    "cache orders",
  );

  // Keep the dev server from going to Shopify while the tests run: mark the
  // cache fresh and push the next allowed refresh out by an hour.
  await db
    .from("fulfillment_orders_cache_state")
    .update({ last_refreshed_at: new Date().toISOString(), last_attempt_at: new Date(Date.now() + 3600_000).toISOString() })
    .eq("id", 1);

  return { tag, products, presets, boxes, orders };
}

export async function cleanupWarehouse(t: WarehouseTestData | null) {
  if (!t) return;
  const db = admin();
  const { error } = await db.rpc("fulfillment_test_cleanup", { p_order_ids: t.orders.map((o) => o.id), p_box_ids: t.boxes.map((b) => b.id) });
  if (error) throw new Error(`cleanup orders/boxes failed: ${error.message}`);
  await db.from("variant_component_map").delete().in("lineitem_name", Object.values(t.products).map((p) => p.lineitem));
  await db.from("product_packaging_rules").delete().in("product_id", Object.values(t.products).map((p) => p.id));
  await db.from("products").delete().in("id", Object.values(t.products).map((p) => p.id));
  await db.from("package_presets").delete().in("id", Object.values(t.presets).map((p) => p.id));
  await db.from("fulfillment_orders_cache_state").update({ last_attempt_at: null }).eq("id", 1);
}

/** The tab (preset nickname or "Needs Review") each test order should land on, using every preset in the dev DB. */
export async function expectedPackages(t: WarehouseTestData): Promise<Record<string, string>> {
  const db = admin();
  const presetRows = must(await db.from("package_presets").select("id, nickname, max_points"), "presets") as any[];
  const ruleRows = must(await db.from("product_packaging_rules").select("product_id, points, min_package_id"), "rules") as any[];
  const presets: PackagingPresetInput[] = presetRows.map((p) => ({ id: p.id, nickname: p.nickname, maxPoints: p.max_points }));
  const rules: PackagingRuleInput[] = ruleRows.map((r) => ({ productId: r.product_id, points: r.points, minPackageId: r.min_package_id }));
  const byLineitem = new Map(Object.values(t.products).map((p) => [p.lineitem, p]));
  const out: Record<string, string> = {};
  for (const o of t.orders) {
    const unmapped = o.lineItems.filter((l) => !byLineitem.has(l.name)).map((l) => l.name);
    const components = o.lineItems.filter((l) => byLineitem.has(l.name)).map((l) => ({ productId: byLineitem.get(l.name)!.id, productName: byLineitem.get(l.name)!.name, qty: l.quantity }));
    const s = suggestPackage({ components, unmappedLineItems: unmapped, rules, presets });
    out[o.id] = s.presetName ?? "Needs Review";
  }
  void sizedPresets;
  return out;
}

/** Order-detail data for a test order (the real route would call Shopify). */
export function mockOrderDetail(t: WarehouseTestData, orderId: string) {
  const o = t.orders.find((x) => x.id === orderId)!;
  return {
    ok: true,
    order: {
      orderId: o.id,
      name: o.name,
      createdAt: "2020-01-01T15:00:00Z",
      customerName: "[TEST] Customer",
      customerEmail: null,
      customerPhone: null,
      shippingAddress: { name: "[TEST] Customer", address1: "1 Invented St", address2: null, city: "Newark", province: "DE", zip: "19711", country: "US", phone: null },
      shippingMethodTitle: "Ground Advantage",
      lineItems: o.lineItems.map((l) => ({ name: l.name, title: l.name, sku: null, quantity: l.quantity, unitWeightOz: 1, extendedWeightOz: l.quantity })),
      totalProductWeightOz: o.lineItems.reduce((s, l) => s + l.quantity, 0),
    },
  };
}

/** Never let a browser test reach Shopify or EasyPost through the order page. */
export async function blockExternalCalls(page: Page, t: WarehouseTestData) {
  await page.route(/\/api\/fulfillments\/TEST-[^/]+$/, (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop()!);
    return route.fulfill({ json: mockOrderDetail(t, id) });
  });
  await page.route(/\/api\/fulfillments\/[^/]+\/rates$/, (route) =>
    route.fulfill({
      json: {
        rates: [{ id: "rate_test", carrier: "USPS", service: "GroundAdvantage", rate: "0.00", currency: "USD", delivery_days: 3 }],
        easypostShipmentId: "shp_test",
        preselectedRateId: "rate_test",
      },
    }),
  );
  await page.route(/\/api\/fulfillments\/[^/]+\/(buy-label|void-label|mark-fulfilled|update-address)$/, (route) =>
    route.fulfill({ status: 418, json: { error: "Blocked in tests: no labels are bought." } }),
  );
}
