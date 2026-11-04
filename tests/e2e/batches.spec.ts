/**
 * Browser tests for batch-level finished goods: batch-aware picking, the
 * out-of-stock flags, Count boxes, Active Batches, the dashboard Flagged
 * Orders table and the read-only View Production page.
 *
 * Invented "[TEST]" data only. Orders are seeded into fulfillment_orders_cache
 * (ids "TEST-<tag>-n"), so nothing calls Shopify; order details and EasyPost
 * rates are mocked in the browser and label purchases are blocked.
 * Screenshots: .private/screens/batches-*.png.
 *
 * Dev database only (see warehouseHelpers.assertDevDatabase).
 */
import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { SCREENS, accessToken, admin, login, userIdFromToken } from "./helpers";
import { assertBrowserOnDevDatabase, assertDevDatabase, blockExternalCalls, cleanupTestBatches, stockTestProducts, type WarehouseTestData } from "./warehouseHelpers";

type Batch = { id: string; code: string };
type Seed = {
  tag: string;
  userId: string;
  product: { id: string; name: string; lineitem: string };
  batchA: Batch; // older, 20 units
  batchB: Batch; // newer, 40 units
  orders: Array<{ id: string; name: string }>;
  boxes: Array<{ id: string; label: string; number: number }>;
  cycleId: string | null;
};

const ORDER_COUNT = 65; // 60 units on the shelf: orders 61-65 are short
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
  const name = `[TEST] Batch Gum ${tag}`;
  const p = must(await db.from("products").insert({ name, unit: "unit", is_microgreen: false, sale_price_per_unit: 5, user_id: userId }).select("id").single(), "product") as { id: string };
  const lineitem = `${name} - Default`;
  must(await db.from("variant_component_map").insert({ lineitem_name: lineitem, business: "botaniqals", components: [{ product_id: p.id, qty_per_unit: 1 }] }).select("id"), "mapping");
  await stockTestProducts([p.id], 0);
  const add = async (qty: number, date: string) =>
    must(await db.rpc("add_manual_batch", { p_product_id: p.id, p_qty: qty, p_produced_date: date, p_note: "[TEST]", p_name: "[TEST] Runner" }), "batch") as {
      batch_id: string;
      batch_code: string;
    };
  const a = await add(20, "2020-01-01");
  const b = await add(40, "2020-02-01");

  const orders = Array.from({ length: ORDER_COUNT }, (_, i) => ({ id: `TEST-${tag}-${i + 1}`, name: `[TEST] #${tag}-${String(i + 1).padStart(2, "0")}` }));
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
            createdAt: new Date(Date.UTC(2020, 0, 1, 15, i)).toISOString(),
            customerName: `[TEST] Customer ${i + 1}`,
            itemCount: 1,
            totalProductWeightOz: 1,
            totalPrice: 5,
            currencyCode: "USD",
            lineItems: [{ name: lineitem, quantity: 1 }],
          },
        })),
      )
      .select("shopify_order_id"),
    "cache orders",
  );
  await db
    .from("fulfillment_orders_cache_state")
    .update({ last_refreshed_at: new Date().toISOString(), last_attempt_at: new Date(Date.now() + 3600_000).toISOString() })
    .eq("id", 1);

  const boxes: Seed["boxes"] = [];
  const base = 700000 + Math.floor(Math.random() * 90000) * 10;
  for (let i = 1; i <= 4; i++) {
    boxes.push(must(await db.from("staging_boxes").insert({ box_number: base + i, is_test: true }).select("id, label, box_number").single(), "box") as any);
  }
  return {
    tag,
    userId,
    product: { id: p.id, name, lineitem },
    batchA: { id: a.batch_id, code: a.batch_code },
    batchB: { id: b.batch_id, code: b.batch_code },
    orders,
    boxes: boxes.map((x: any) => ({ id: x.id, label: x.label, number: x.box_number })),
    cycleId: null,
  };
}

async function cleanup(t: Seed | null) {
  if (!t) return;
  const db = admin();
  const orderIds = t.orders.map((o) => o.id);
  await db.rpc("fulfillment_test_cleanup", { p_order_ids: orderIds, p_box_ids: t.boxes.map((b) => b.id) });
  await cleanupTestBatches([t.product.id], orderIds);
  if (t.cycleId) {
    await db.from("cycle_completion_snapshots").delete().eq("production_cycle_id", t.cycleId);
    await db.from("botaniqals_production_batches").delete().eq("production_cycle_id", t.cycleId);
    await db.from("production_targets").delete().eq("production_cycle", t.cycleId);
    await db.from("production_cycles").delete().eq("id", t.cycleId);
  }
  await db.from("variant_component_map").delete().eq("lineitem_name", t.product.lineitem);
  await db.from("products").delete().eq("id", t.product.id);
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

const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SCREENS, `batches-${name}.png`), fullPage: true });

/** The order-detail mocks from the warehouse helpers, shaped for these orders. */
function asWarehouseData(t: Seed): WarehouseTestData {
  return {
    tag: t.tag,
    products: { gum: { ...t.product }, spray: { ...t.product }, paste: { ...t.product } },
    presets: {} as WarehouseTestData["presets"],
    boxes: t.boxes,
    orders: t.orders.map((o) => ({ ...o, lineItems: [{ name: t.product.lineitem, quantity: 1 }] })),
  };
}

const row = (page: Page, n: number) => page.getByTestId(`pick-row-${s!.orders[n - 1].id}`);

async function openPickList(page: Page, waitFor = 1) {
  await blockExternalCalls(page, asWarehouseData(s!));
  await page.goto("/fulfillments/pick-list");
  await page.getByLabel("Search order # or customer").fill(s!.tag);
  await expect(row(page, waitFor)).toBeVisible({ timeout: 30_000 });
}

async function chooseBox(page: Page, n: number, box: Seed["boxes"][number]) {
  const input = row(page, n).getByRole("combobox");
  await input.click();
  await input.fill(String(box.number));
  await page.getByRole("option", { name: box.label, exact: true }).click();
  await expect(input).toHaveValue(box.label);
}

const remaining = async (b: Batch) =>
  ((await admin().from("finished_goods_batches").select("remaining_qty, status").eq("id", b.id).single()).data as { remaining_qty: number; status: string });

const statusOf = async (n: number) =>
  (await admin().from("order_status").select("status, is_flagged, flag_source, flag_detail").eq("shopify_order_id", s!.orders[n - 1].id).maybeSingle()).data as any;

test("Pick List: 65 orders split across two batches oldest first; 5 short orders are flagged automatically", async ({ page }) => {
  await login(page);
  await openPickList(page);
  const line = (n: number) => row(page, n).getByTestId(`pick-line-${s!.product.name}`);
  await expect(line(1)).toContainText(`pull from Batch ${s!.batchA.code}`);
  await expect(line(20)).toContainText(`pull from Batch ${s!.batchA.code}`);
  await expect(row(page, 20).getByTestId("box-empties")).toBeVisible();
  await expect(row(page, 19).getByTestId("box-empties")).toHaveCount(0);
  await expect(line(21)).toContainText(`pull from Batch ${s!.batchB.code}`);
  await expect(line(60)).toContainText(`pull from Batch ${s!.batchB.code}`);
  await expect(row(page, 60).getByTestId("box-empties")).toBeVisible();
  // Orders 61-65: short and flagged automatically, so hidden until flagged
  // orders are included; Mark as Picked stays disabled.
  await expect(row(page, 61)).toHaveCount(0);
  await page.getByLabel(/Include flagged orders/).check();
  for (const n of [61, 65]) {
    await expect(row(page, n)).toContainText("short by 1 (needs 1, available 0)");
    await expect(row(page, n).getByRole("button", { name: "Mark as Picked" })).toBeDisabled();
  }
  const st = await statusOf(61);
  expect(st).toMatchObject({ is_flagged: true, flag_source: "auto_out_of_stock" });
  expect(st.flag_detail[0]).toMatchObject({ product_id: s!.product.id, needed: 1, available: 0, short_by: 1 });
  expect((await statusOf(60))?.is_flagged ?? false).toBe(false);
  await shot(page, "pick-list-split");
});

test("Picking takes units from the planned batch; a stale plan is rejected and reloaded", async ({ page }) => {
  await login(page);
  await openPickList(page);
  await chooseBox(page, 1, s!.boxes[0]);
  await row(page, 1).getByRole("button", { name: "Mark as Picked" }).click();
  await expect(row(page, 1)).toHaveCount(0, { timeout: 15_000 });
  expect((await remaining(s!.batchA)).remaining_qty).toBe(19);

  // Order 2's plan says batch A. Someone counts batch A down to 0 meanwhile:
  // the plan for order 2 moves to batch B and the pick is refused with a reload.
  await chooseBox(page, 2, s!.boxes[1]);
  const counted = await admin().rpc("count_batches", {
    p_counts: [{ batch_id: s!.batchA.id, expected_remaining: 19, counted_qty: 0, reason: "[TEST] Damaged" }],
    p_name: "[TEST] Runner",
  });
  expect(counted.error).toBeNull();
  const res = page.waitForResponse((r) => r.url().endsWith(`/api/fulfillments/${s!.orders[1].id}/pick`));
  await row(page, 2).getByRole("button", { name: "Mark as Picked" }).click();
  const r = await res;
  expect(r.status()).toBe(409);
  expect((await r.json()).code).toBe("plan_changed");
  await expect(row(page, 2).getByRole("alert")).toContainText("Batch instructions changed. Reloaded.");
  await expect(row(page, 2).getByTestId(`pick-line-${s!.product.name}`)).toContainText(`pull from Batch ${s!.batchB.code}`);
  expect((await remaining(s!.batchA)).status).toBe("depleted");
  await shot(page, "pick-list-plan-changed");

  // Picking again with the reloaded plan works.
  await chooseBox(page, 2, s!.boxes[1]);
  await row(page, 2).getByRole("button", { name: "Mark as Picked" }).click();
  await expect(row(page, 2)).toHaveCount(0, { timeout: 15_000 });
  expect((await remaining(s!.batchB)).remaining_qty).toBe(39);
});

test("Picked from a different batch: override with a reason, shown on the order", async ({ page }) => {
  // Put 5 units back into an older box so there is a real choice of batches.
  const c = await admin().rpc("count_batches", {
    p_counts: [{ batch_id: s!.batchA.id, expected_remaining: 0, counted_qty: 5, reason: "[TEST] Recount" }],
    p_name: "[TEST] Runner",
  });
  expect(c.error).toBeNull();
  await login(page);
  await openPickList(page, 3);
  // Order 3 is now planned from batch A; the picker pulled from batch B instead.
  await expect(row(page, 3).getByTestId(`pick-line-${s!.product.name}`)).toContainText(`pull from Batch ${s!.batchA.code}`);
  await row(page, 3).getByRole("button", { name: "Picked from a different batch" }).click();
  const dialog = page.getByRole("dialog");
  // Prefilled with the planned batch.
  await expect(dialog.getByLabel(`Units from batch ${s!.batchA.code}`)).toHaveValue("1");
  await dialog.getByLabel(`Units from batch ${s!.batchA.code}`).fill("");
  await dialog.getByLabel(`Units from batch ${s!.batchB.code}`).fill("1");
  await dialog.getByRole("button", { name: "Use these batches" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Choose a reason.");
  await dialog.locator("#override-reason").selectOption("Grabbed wrong box");
  await dialog.getByRole("button", { name: "Use these batches" }).click();
  await expect(row(page, 3)).toContainText(`pull from Batch ${s!.batchB.code}`);
  await expect(row(page, 3)).toContainText("Different batch");
  await chooseBox(page, 3, s!.boxes[2]);
  await shot(page, "override-before-pick");
  await row(page, 3).getByRole("button", { name: "Mark as Picked" }).click();
  await expect(row(page, 3)).toHaveCount(0, { timeout: 15_000 });
  expect((await remaining(s!.batchA)).remaining_qty).toBe(5);
  expect((await remaining(s!.batchB)).remaining_qty).toBe(38);

  await page.goto(`/fulfillments/${s!.orders[2].id}`);
  const card = page.getByTestId("batches-card");
  await expect(card).toContainText(s!.batchB.code, { timeout: 30_000 });
  await expect(card).toContainText("Picked from different batch");
  await shot(page, "order-batches-card");
});

test("Return to Picking puts the units back into the same batch", async ({ page }) => {
  await login(page);
  await openPickList(page, 4);
  const before = (await remaining(s!.batchB)).remaining_qty;
  await page.getByRole("row", { name: new RegExp(s!.orders[2].name.replace(/[[\]#]/g, "\\$&")) }).getByRole("button", { name: "Return to Picking" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Return to Picking" }).click();
  await expect(row(page, 3)).toBeVisible({ timeout: 15_000 });
  expect((await remaining(s!.batchB)).remaining_qty).toBe(before + 1);
  const picks = (await admin().from("order_batch_picks").select("reversed_at").eq("order_id", s!.orders[2].id)).data as Array<{ reversed_at: string | null }>;
  expect(picks.length).toBe(1);
  expect(picks[0].reversed_at).not.toBeNull();
});

test("Count boxes: review, then a count is rejected when a box changed meanwhile", async ({ page }) => {
  await login(page);
  await page.goto("/finished-products-inventory?view=batches&count=1");
  const dialog = page.getByRole("dialog", { name: "Count boxes" });
  await expect(dialog.getByTestId(`count-row-${s!.batchA.code}`)).toBeVisible({ timeout: 30_000 });
  await dialog.getByLabel(`Counted for batch ${s!.batchA.code}`).fill("3");
  await dialog.getByLabel(`Reason for batch ${s!.batchA.code}`).selectOption("Sold at market");
  await dialog.locator("#count-person").selectOption({ index: 1 });
  await dialog.getByRole("button", { name: "Review" }).click();
  await expect(dialog.getByTestId("count-review")).toContainText(s!.batchA.code);
  await shot(page, "count-review");

  // Someone picks from batch A while the count is open.
  const r = await admin().rpc("mark_order_picked", {
    p_order_id: s!.orders[3].id,
    p_box_id: s!.boxes[3].id,
    p_order_name: s!.orders[3].name,
    p_allocations: [{ product_id: s!.product.id, batch_id: s!.batchA.id, qty: 1 }],
    p_required: { [s!.product.id]: 1 },
  });
  expect(r.error).toBeNull();
  await dialog.getByRole("button", { name: "Save count" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByTestId(`count-row-${s!.batchA.code}`)).toContainText("Changed: re-enter");
  await expect(dialog.getByTestId(`count-row-${s!.batchA.code}`)).toContainText("4");
  expect((await remaining(s!.batchA)).remaining_qty).toBe(4); // nothing written
  await shot(page, "count-stale");

  // Re-enter and save.
  await dialog.getByLabel(`Counted for batch ${s!.batchA.code}`).fill("3");
  await dialog.getByLabel(`Reason for batch ${s!.batchA.code}`).selectOption("Sold at market");
  await dialog.getByRole("button", { name: "Review" }).click();
  await dialog.getByRole("button", { name: "Save count" }).click();
  await expect(page.getByRole("status")).toContainText("Count saved", { timeout: 15_000 });
  expect((await remaining(s!.batchA)).remaining_qty).toBe(3);
});

test("Active Batches: next to pick, planned units, emptied batches toggle, expandable history", async ({ page }) => {
  await login(page);
  await page.goto("/finished-products-inventory?view=batches");
  const panel = page.getByTestId("active-batches-panel");
  const rowA = panel.getByTestId(`batch-row-${s!.batchA.code}`);
  await expect(rowA).toBeVisible({ timeout: 30_000 });
  await expect(rowA).toContainText("Next to pick");
  await expect(panel.getByTestId(`batch-row-${s!.batchB.code}`)).not.toContainText("Next to pick");
  await rowA.click();
  await expect(panel).toContainText(s!.orders[3].name, { timeout: 15_000 });
  await shot(page, "active-batches");

  // Empty batch A by count: it leaves the list unless emptied batches are shown.
  await admin().rpc("count_batches", {
    p_counts: [{ batch_id: s!.batchA.id, expected_remaining: 3, counted_qty: 0, reason: "[TEST] Damaged" }],
    p_name: "[TEST] Runner",
  });
  await page.reload();
  await expect(panel.getByTestId(`batch-row-${s!.batchB.code}`)).toContainText("Next to pick", { timeout: 30_000 });
  await expect(panel.getByTestId(`batch-row-${s!.batchA.code}`)).toHaveCount(0);
  await panel.getByLabel("Show emptied batches").check();
  await expect(panel.getByTestId(`batch-row-${s!.batchA.code}`)).toBeVisible();
});

test("Adding a batch clears the automatic out-of-stock flags", async ({ page }) => {
  await login(page);
  // Shelf now: batch B has 38 for 61 waiting orders, so 23 are short and flagged.
  await page.goto("/finished-products-inventory");
  await expect(page.getByTestId(`fg-row-${s!.product.name}`)).toContainText("Short by", { timeout: 30_000 });
  await shot(page, "fg-short");
  await page.goto("/finished-products-inventory?view=batches");
  await page.getByRole("button", { name: "Add batch manually" }).click();
  await page.locator("#add-product").selectOption({ label: s!.product.name });
  await page.locator("#add-qty").fill("100");
  await page.locator("#add-date").fill("2026-11-02");
  await page.locator("#add-person").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Add batch", exact: true }).click();
  await expect(page.getByRole("status")).toBeVisible({ timeout: 15_000 });
  // The overview call syncs flags; the pick list also does.
  await openPickList(page, 65);
  await expect(row(page, 65).getByRole("button", { name: "Mark as Picked" })).toBeDisabled(); // no box yet
  await expect(row(page, 65)).not.toContainText("short by");
  const st = await statusOf(65);
  expect(st?.is_flagged ?? false).toBe(false);
  const events = (await admin().from("order_events").select("event_type").eq("order_id", s!.orders[64].id)).data as Array<{ event_type: string }>;
  expect(events.map((e) => e.event_type)).toEqual(expect.arrayContaining(["auto_flagged_out_of_stock", "auto_unflagged"]));
});

test("Dashboard: Flagged Orders table scrolls inside the card", async ({ page }) => {
  // Flag 15 orders by hand so the table is taller than the card.
  for (const o of s!.orders.slice(40, 55)) {
    await admin().from("order_status").upsert({ shopify_order_id: o.id, status: "preparing_shipment", is_flagged: true, flagged_reason: "[TEST] check", flag_source: "manual" }, { onConflict: "shopify_order_id" });
  }
  await login(page);
  await page.goto("/");
  const card = page.getByRole("region", { name: "Flagged Orders" });
  await expect(card).toContainText(s!.orders[40].name, { timeout: 30_000 });
  const scroll = card.getByTestId("flagged-orders-scroll");
  const dims = await scroll.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
  expect(dims.scrollHeight).toBeGreaterThan(dims.clientHeight);
  expect(dims.clientHeight).toBeLessThanOrEqual(320);
  await shot(page, "dashboard-flagged");
});

test("View Production: a completed cycle opens read-only with its batches", async ({ page }) => {
  const db = admin();
  const cycle = must(await db.from("production_cycles").insert({ user_id: s!.userId, status: "in_progress", brand: "botaniqals", business_type: "botaniqals", start_date: "2026-11-01" }).select("id").single(), "cycle") as { id: string };
  s!.cycleId = cycle.id;
  must(await db.from("production_targets").insert({ user_id: s!.userId, production_cycle: cycle.id, product: s!.product.id, quantity_to_produce: 12 }).select("id"), "target");
  const done = await db.rpc("complete_botaniqals_production", {
    p_cycle_id: cycle.id,
    p_actuals: { [s!.product.id]: 12 },
    p_snapshot: { lines: [], sale_price_per_unit: 5, total_cost: 0, per_product: [{ product_id: s!.product.id, name: s!.product.name, qty: 12, sale_price_per_unit: 5, cost: 0 }] },
    p_completed_at: "2026-11-02T17:00:00Z",
  });
  expect(done.error).toBeNull();
  const code = (done.data as any).batches[0].batch_code as string;

  await login(page);
  await page.goto(`/cycles/${cycle.id}/summary`);
  await expect(page.getByTestId("view-only-banner")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("summary-batches")).toContainText(code);
  await expect(page.getByTestId("current-prices-note")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Save|Edit|Reopen/ })).toHaveCount(0);
  await shot(page, "view-production");
});
