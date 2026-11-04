/* eslint-disable @typescript-eslint/no-explicit-any -- loose types for test fakes and database rows */
/**
 * Browser tests for Void Label at any stage, replacement labels after
 * fulfillment, and orders staying visible until fulfilled.
 *
 * Invented "[TEST]" data only, orders "TEST-<tag>-…" seeded into the cache.
 * The dev server must run with E2E_MODE=1: then EasyPost calls for invented
 * "shp_e2e_…" shipments and Shopify calls for "TEST-…" orders are answered by
 * src/lib/e2eFakes (never real services). Order details and rate quotes are
 * mocked in the browser. Screenshots: .private/screens/labels-*.png.
 *
 * Dev database only (see warehouseHelpers.assertDevDatabase).
 */
import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { SCREENS, accessToken, admin, login, userIdFromToken } from "./helpers";
import { assertBrowserOnDevDatabase, assertDevDatabase, cleanupTestBatches, stockTestProducts } from "./warehouseHelpers";

type Seed = {
  tag: string;
  productId: string;
  lineitem: string;
  presetId: string;
  boxes: Array<{ id: string; label: string }>;
  orders: Record<"printed" | "fulfilled" | "shopifyFail" | "visible", { id: string; name: string }>;
};
let s: Seed | null = null;

test.describe.configure({ mode: "serial" });

const must = <T,>(r: { data: T; error: { message: string } | null }, what: string): NonNullable<T> => {
  if (r.error || r.data == null) throw new Error(`${what}: ${r.error?.message ?? "no data"}`);
  return r.data as NonNullable<T>;
};

async function seed(userId: string): Promise<Seed> {
  assertDevDatabase();
  const db = admin();
  const tag = Math.random().toString(36).slice(2, 7);
  const name = `[TEST] Label Gum ${tag}`;
  const p = must(await db.from("products").insert({ name, unit: "unit", is_microgreen: false, sale_price_per_unit: 5, user_id: userId }).select("id").single(), "product") as { id: string };
  const lineitem = `${name} - Default`;
  must(await db.from("variant_component_map").insert({ lineitem_name: lineitem, business: "botaniqals", components: [{ product_id: p.id, qty_per_unit: 1 }] }).select("id"), "mapping");
  await stockTestProducts([p.id], 50);
  const preset = must(
    await db
      .from("package_presets")
      .insert({ user_id: userId, nickname: `[TEST] Mailer ${tag}`, length_in: 9, width_in: 6, height_in: 1, tare_weight_oz: 0.5, max_points: Number((40 + Math.random()).toFixed(2)) })
      .select("id")
      .single(),
    "preset",
  ) as { id: string };

  const orders = {
    printed: { id: `TEST-${tag}-1`, name: `[TEST] #${tag}-1` },
    fulfilled: { id: `TEST-${tag}-2`, name: `[TEST] #${tag}-2` },
    shopifyFail: { id: `TEST-${tag}-SHOPIFYFAIL`, name: `[TEST] #${tag}-3` },
    visible: { id: `TEST-${tag}-4`, name: `[TEST] #${tag}-4` },
  };
  must(
    await db
      .from("fulfillment_orders_cache")
      .insert(
        Object.values(orders).map((o, i) => ({
          shopify_order_id: o.id,
          source: "test",
          payload: {
            orderId: o.id, name: o.name, createdAt: new Date(Date.UTC(2020, 0, 1, 15, i)).toISOString(),
            customerName: `[TEST] Customer ${i + 1}`, itemCount: 1, totalProductWeightOz: 1, totalPrice: 5, currencyCode: "USD",
            lineItems: [{ name: lineitem, quantity: 1 }],
          },
        })),
      )
      .select("shopify_order_id"),
    "cache",
  );
  await db
    .from("fulfillment_orders_cache_state")
    .update({ last_refreshed_at: new Date().toISOString(), last_attempt_at: new Date(Date.now() + 3600_000).toISOString() })
    .eq("id", 1);

  const base = 600000 + Math.floor(Math.random() * 90000) * 10;
  const boxes: Seed["boxes"] = [];
  for (let i = 1; i <= 3; i++) boxes.push(must(await db.from("staging_boxes").insert({ box_number: base + i, is_test: true }).select("id, label").single(), "box") as any);

  // Picked orders (into boxes). The two "fulfilled" ones get a label and are
  // fulfilled the way Mark Fulfilled leaves them (box released).
  const pickInto = async (o: { id: string; name: string }, box: string) =>
    must(
      await db.rpc("mark_order_picked", {
        p_order_id: o.id, p_box_id: box, p_order_name: o.name,
        p_allocations: [], p_required: {},
      }),
      `pick ${o.id}`,
    );
  await pickInto(orders.printed, boxes[0].id);
  await pickInto(orders.visible, boxes[1].id);
  for (const o of [orders.fulfilled, orders.shopifyFail]) {
    await pickInto(o, boxes[2].id);
    must(await db.rpc("begin_label_purchase", { p_order_id: o.id }), "begin");
    must(
      await db.rpc("complete_label_purchase", {
        p_order_id: o.id,
        p_log: { tracking_number: `E2E-OLD-${o.id}`, carrier: "USPS", service: "GroundAdvantage", label_url: "about:blank", easypost_shipment_id: "shp_e2e_reject_old", rate_amount: "4.50", rate_currency: "USD" },
      }),
      "complete",
    );
    await db.from("order_status").update({ status: "fulfilled" }).eq("shopify_order_id", o.id);
    await db.from("fulfillment_log").update({ fulfilled_at: new Date().toISOString(), shopify_fulfillment_id: "gid://shopify/Fulfillment/e2e" }).eq("shopify_order_id", o.id);
    must(await db.rpc("release_assignment_on_fulfilled", { p_order_id: o.id }), "release");
  }
  // The "visible" order gets a printed label (it must stay on every list).
  must(await db.rpc("begin_label_purchase", { p_order_id: orders.visible.id }), "begin visible");
  const rec = must(
    await db.rpc("complete_label_purchase", {
      p_order_id: orders.visible.id,
      p_log: { tracking_number: "E2E-VIS", carrier: "USPS", service: "GroundAdvantage", label_url: "about:blank", easypost_shipment_id: "shp_e2e_vis", rate_amount: "4.50", rate_currency: "USD" },
    }),
    "complete visible",
  ) as { log_id: string };
  must(await db.rpc("mark_label_printed", { p_order_id: orders.visible.id, p_log_id: rec.log_id }), "print visible");

  return { tag, productId: p.id, lineitem, presetId: preset.id, boxes, orders };
}

async function cleanup(t: Seed | null) {
  if (!t) return;
  const db = admin();
  const ids = Object.values(t.orders).map((o) => o.id);
  const { error } = await db.rpc("fulfillment_test_cleanup", { p_order_ids: ids, p_box_ids: t.boxes.map((b) => b.id) });
  if (error) throw new Error(`cleanup: ${error.message}`);
  await cleanupTestBatches([t.productId], ids);
  await db.from("variant_component_map").delete().eq("lineitem_name", t.lineitem);
  await db.from("products").delete().eq("id", t.productId);
  await db.from("package_presets").delete().eq("id", t.presetId);
  await db.from("fulfillment_orders_cache_state").update({ last_attempt_at: null }).eq("id", 1);
}

test.beforeAll(async ({ browser }) => {
  assertDevDatabase();
  const page = await browser.newPage();
  await login(page);
  await assertBrowserOnDevDatabase(page);
  s = await seed(userIdFromToken(await accessToken(page)));
  await page.close();
});
test.afterAll(async () => {
  await cleanup(s);
});

const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SCREENS, `labels-${name}.png`), fullPage: true });

/** Order details and rate quotes come from the browser mock; buy, void, print go to the server (E2E fakes). */
async function mockOrderAndRates(page: Page, shipmentId: string) {
  await page.route(/\/api\/fulfillments\/TEST-[^/]+$/, (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop()!);
    const o = Object.values(s!.orders).find((x) => x.id === id)!;
    return route.fulfill({
      json: {
        ok: true,
        order: {
          orderId: o.id, name: o.name, createdAt: "2020-01-01T15:00:00Z", customerName: "[TEST] Customer", customerEmail: null, customerPhone: null,
          shippingAddress: { name: "[TEST] Customer", address1: "1 Invented St", address2: null, city: "Newark", province: "DE", zip: "19711", country: "US", phone: null },
          shippingMethodTitle: "Ground Advantage",
          lineItems: [{ name: s!.lineitem, title: s!.lineitem, sku: null, quantity: 1, unitWeightOz: 1, extendedWeightOz: 1 }],
          totalProductWeightOz: 1,
        },
      },
    });
  });
  await page.route(/\/api\/fulfillments\/[^/]+\/rates$/, (route) =>
    route.fulfill({
      json: {
        rates: [{ id: "rate_e2e", carrier: "USPS", service: "GroundAdvantage", rate: "4.50", currency: "USD", delivery_days: 3 }],
        easypostShipmentId: shipmentId,
        preselectedRateId: "rate_e2e",
      },
    }),
  );
  await page.route(/\/api\/fulfillments\/[^/]+\/(mark-fulfilled|update-address)$/, (route) =>
    route.fulfill({ status: 418, json: { error: "Blocked in tests." } }),
  );
}

async function generateLabel(page: Page) {
  await page.getByRole("button", { name: "Generate Label" }).first().click();
  const popup = page.locator("div.fixed").filter({ hasText: "Packaging Preset" });
  await popup.getByRole("combobox").first().selectOption(s!.presetId);
  await expect(popup.getByRole("combobox").nth(1)).toHaveValue("rate_e2e", { timeout: 20_000 });
  return popup;
}

const statusOf = async (id: string) => ((await admin().from("order_status").select("status").eq("shopify_order_id", id).single()).data as any).status as string;
const openBox = async (id: string) => ((await admin().from("staging_box_assignments").select("id").eq("order_id", id).is("released_at", null)).data ?? []).length > 0;

test("Label Printed: void works even when EasyPost rejects the refund; the order goes back to Picked", async ({ page, context }) => {
  context.on("page", (p) => p.close().catch(() => {})); // Print opens the label in a new tab
  await login(page);
  await mockOrderAndRates(page, "shp_e2e_reject_new");
  await page.goto(`/fulfillments/${s!.orders.printed.id}`);
  const popup = await generateLabel(page);
  await popup.getByRole("button", { name: "Generate Label" }).click();
  await expect(page.getByRole("button", { name: "Print Label" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Print Label" }).click();
  await expect.poll(() => statusOf(s!.orders.printed.id)).toBe("label_printed");

  await page.getByRole("button", { name: "Void Label" }).click();
  const dialog = page.getByRole("dialog", { name: "Void this label?" });
  await expect(dialog).toContainText("We'll ask EasyPost for a refund");
  await expect(dialog.getByTestId("void-fulfilled-note")).toHaveCount(0);
  const confirm = dialog.getByRole("button", { name: "Void Label" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Note (optional)").fill("[TEST] wrong address");
  await dialog.getByLabel("I won't use the old label").check();
  await shot(page, "void-modal");
  await confirm.click();
  await expect(page.getByTestId("label-notice")).toContainText(
    "Label voided. EasyPost rejected the refund: Unable to request refund. The parcel has been shipped. You may not get this postage back.",
    { timeout: 20_000 },
  );
  expect(await statusOf(s!.orders.printed.id)).toBe("picked");
  expect(await openBox(s!.orders.printed.id)).toBe(true);
  const history = page.getByTestId("label-history");
  await expect(history).toContainText("Refund rejected");
  await expect(history).toContainText("[TEST] wrong address");
  await expect(history.getByRole("button", { name: "Retry refund" })).toBeVisible();
  await shot(page, "void-rejected");
});

test("Fulfilled: void keeps it fulfilled, shows Needs new label; a replacement updates Shopify", async ({ page }) => {
  const o = s!.orders.fulfilled;
  await login(page);
  await mockOrderAndRates(page, "shp_e2e_ok");
  await page.goto(`/fulfillments/${o.id}`);
  await page.getByRole("button", { name: "Void Label" }).click();
  const dialog = page.getByRole("dialog", { name: "Void this label?" });
  await expect(dialog.getByTestId("void-fulfilled-note")).toContainText(`Shopify still shows tracking number E2E-OLD-${o.id} until you generate a replacement label.`);
  await dialog.getByLabel("I won't use the old label").check();
  await dialog.getByRole("button", { name: "Void Label" }).click();
  await expect(page.getByTestId("needs-new-label-badge")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("needs-new-label-banner")).toContainText(`Label voided. Shopify still shows tracking number E2E-OLD-${o.id}. Generate a replacement label.`);
  expect(await statusOf(o.id)).toBe("fulfilled");
  expect(await openBox(o.id)).toBe(false);
  await shot(page, "needs-new-label");

  // Fulfillments list: badge and the "Needs new label" filter.
  await page.goto("/fulfillments");
  await page.getByLabel("Order #").fill(s!.tag);
  await page.getByLabel("Status").selectOption("needs_new_label");
  const row = page.getByRole("row", { name: new RegExp(o.name.replace(/[[\]#]/g, "\\$&")) });
  await expect(row.getByTestId("needs-new-label")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("row", { name: new RegExp(s!.orders.visible.name.replace(/[[\]#]/g, "\\$&")) })).toHaveCount(0);
  await shot(page, "list-needs-new-label");

  // Replacement label with the notify checkbox.
  await page.goto(`/fulfillments/${o.id}`);
  const popup = await generateLabel(page);
  await expect(popup).toContainText("The customer was already emailed the old tracking number.");
  const notify = popup.getByLabel("Notify customer of the new tracking number");
  await expect(notify).toBeChecked();
  await notify.uncheck();
  await popup.getByRole("button", { name: "Generate Label" }).click();
  await expect(page.getByTestId("label-notice")).toContainText("Replacement label created. Shopify now shows tracking number E2E-TRK-", { timeout: 20_000 });
  await expect(page.getByTestId("needs-new-label-badge")).toHaveCount(0);
  expect(await statusOf(o.id)).toBe("fulfilled");
  const { data: rows } = await admin().from("fulfillment_log").select("is_replacement, notify_customer, shopify_tracking_synced_at, voided_at").eq("shopify_order_id", o.id).is("voided_at", null);
  expect(rows).toHaveLength(1);
  expect(rows![0]).toMatchObject({ is_replacement: true, notify_customer: false });
  expect(rows![0].shopify_tracking_synced_at).not.toBeNull();

  // Print on the replacement: the order stays fulfilled.
  page.context().on("page", (p) => p.close().catch(() => {}));
  await page.getByRole("button", { name: "Print Label" }).click();
  await expect.poll(async () => ((await admin().from("fulfillment_log").select("printed_at").eq("shopify_order_id", o.id).is("voided_at", null).single()).data as any).printed_at).not.toBeNull();
  expect(await statusOf(o.id)).toBe("fulfilled");
  await expect(page.getByTestId("label-history")).toContainText("Replacement");
  await shot(page, "replacement");
});

test("A Shopify failure keeps the replacement label and offers Retry Shopify update", async ({ page }) => {
  const o = s!.orders.shopifyFail;
  await login(page);
  await mockOrderAndRates(page, "shp_e2e_ok2");
  await page.goto(`/fulfillments/${o.id}`);
  await page.getByRole("button", { name: "Void Label" }).click();
  const dialog = page.getByRole("dialog", { name: "Void this label?" });
  await dialog.getByLabel("I won't use the old label").check();
  await dialog.getByRole("button", { name: "Void Label" }).click();
  await expect(page.getByTestId("needs-new-label-badge")).toBeVisible({ timeout: 20_000 });
  const popup = await generateLabel(page);
  await popup.getByRole("button", { name: "Generate Label" }).click();
  await expect(page.getByTestId("label-notice")).toContainText("The new label was created, but Shopify still shows the old tracking number.", { timeout: 20_000 });
  const warning = page.getByTestId("shopify-sync-warning");
  await expect(warning).toContainText("Simulated Shopify error");
  await expect(warning.getByRole("button", { name: "Retry Shopify update" })).toBeVisible();
  await warning.getByRole("button", { name: "Retry Shopify update" }).click();
  await expect(page.locator("p[role=alert]")).toContainText("Simulated Shopify error", { timeout: 20_000 });
  expect(await statusOf(o.id)).toBe("fulfilled");
  await shot(page, "shopify-warning");
});

test("A Label Printed order stays on the Fulfillments list and its Shipping Assignments tab", async ({ page }) => {
  const o = s!.orders.visible;
  await login(page);
  await page.goto("/fulfillments");
  await page.getByLabel("Order #").fill(s!.tag);
  const row = page.getByRole("row", { name: new RegExp(o.name.replace(/[[\]#]/g, "\\$&")) });
  await expect(row).toContainText("Label Printed", { timeout: 30_000 });
  await expect(row).toContainText(s!.boxes[1].label);
  await page.goto("/fulfillments/shipping-assignments");
  await page.getByLabel("Search STG box or order #").fill(s!.tag);
  // Needs Review (this test product has no packaging rule).
  await page.getByTestId("tab-Needs Review").click();
  await expect(page.getByTestId(`ship-row-${o.id}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`ship-row-${o.id}`)).toContainText("Label Printed");
  await expect(page.getByTestId(`ship-row-${s!.orders.fulfilled.id}`)).toHaveCount(0);
  expect(await openBox(o.id)).toBe(true);
  await shot(page, "shipping-label-printed");
});
