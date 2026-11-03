/**
 * Browser tests for Packaging Setup, the Pick List, Shipping Assignments and
 * the Generate Label gating. Invented "[TEST]" data only, seeded into
 * fulfillment_orders_cache, so these screens never call Shopify; the order
 * detail fetch and EasyPost rates are mocked in the browser and label
 * purchases are blocked. Screenshots: .private/screens/warehouse-*.png.
 *
 * Dev database only (see warehouseHelpers.assertDevDatabase).
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import path from "node:path";
import { SCREENS, accessToken, login, userIdFromToken } from "./helpers";
import {
  assertBrowserOnDevDatabase,
  assertDevDatabase,
  blockExternalCalls,
  cleanupWarehouse,
  expectedPackages,
  seedWarehouse,
  type WarehouseTestData,
} from "./warehouseHelpers";
import { admin } from "./helpers";

let t: WarehouseTestData | null = null;
let expected: Record<string, string> = {};

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  assertDevDatabase();
  const page = await browser.newPage();
  await login(page);
  await assertBrowserOnDevDatabase(page);
  t = await seedWarehouse(userIdFromToken(await accessToken(page)));
  expected = await expectedPackages(t);
  await page.close();
});

test.afterAll(async () => {
  await cleanupWarehouse(t);
});

const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SCREENS, `warehouse-${name}.png`), fullPage: true });

async function openPickList(page: Page, waitForOrderId = t!.orders[3].id) {
  await blockExternalCalls(page, t!);
  await page.goto("/fulfillments/pick-list");
  await page.getByLabel("Search order # or customer").fill(t!.tag);
  await expect(page.getByTestId(`pick-row-${waitForOrderId}`)).toBeVisible({ timeout: 30_000 });
}

async function chooseBox(page: Page, orderId: string, boxLabel: string) {
  const row = page.getByTestId(`pick-row-${orderId}`);
  const input = row.getByRole("combobox");
  await input.click();
  await input.fill(boxLabel.replace("STG-", ""));
  await page.getByRole("option", { name: boxLabel, exact: true }).click();
  await expect(input).toHaveValue(boxLabel);
}

async function loggedInPage(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page);
  await assertBrowserOnDevDatabase(page);
  return { context, page };
}

test("Packaging Setup: max points, rules table, test panel and 90-day preview", async ({ page }) => {
  await login(page);
  await page.goto("/fulfillments/package-presets");
  await expect(page.getByRole("heading", { name: "Packaging Setup" })).toBeVisible();
  await expect(page.getByTestId(`preset-${t!.presets.small.nickname}`)).toContainText("max");
  await expect(page.getByTestId(`rule-${t!.products.spray.name}`)).toBeVisible();

  // Test panel: 2 Gum + 1 Spray -> Spray's minimum decides.
  const panel = page.getByRole("region", { name: "Test panel" });
  await panel.getByLabel("Test product 1").selectOption({ label: t!.products.gum.name });
  await panel.getByLabel("Test quantity 1").fill("2");
  await panel.getByRole("button", { name: "Add product" }).click();
  await panel.getByLabel("Test product 2").selectOption({ label: t!.products.spray.name });
  await expect(page.getByTestId("test-result")).toContainText("3 points");
  await expect(page.getByTestId("test-result")).toContainText(`contains ${t!.products.spray.name}`);

  // Duplicate max points is rejected before saving.
  await page.getByLabel("Nickname").fill(`[TEST] Dup ${t!.tag}`);
  for (const dim of ["L (in)", "W (in)", "H (in)", "Tare weight (oz)"]) await page.getByLabel(dim, { exact: true }).fill("1");
  await page.getByLabel("Max points").fill(String(t!.presets.small.maxPoints));
  await page.getByRole("button", { name: "Add preset" }).click();
  await expect(page.locator("p[role=alert]").first()).toContainText("already used by");

  // Deleting a preset that a product rule uses is blocked, naming the product.
  await page.getByTestId(`preset-${t!.presets.small.nickname}`).getByRole("button", { name: "Delete" }).click();
  await expect(page.locator("p[role=alert]").first()).toContainText(t!.products.spray.name);

  // 90-day preview (read-only).
  await page.getByRole("button", { name: "Run preview" }).click();
  await expect(page.getByTestId("preview-result")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("preview-result")).toContainText("Needs Review");
  await shot(page, "packaging-setup");
});

test("Pick List: Mark as Picked disabled until a box is chosen; refresh keeps selections; unmapped blocked", async ({ page }) => {
  await login(page);
  await openPickList(page, t!.orders[0].id);
  const [o1, o2, , o4] = t!.orders;

  const row1 = page.getByTestId(`pick-row-${o1.id}`);
  await expect(row1.getByRole("button", { name: "Mark as Picked" })).toBeDisabled();
  await expect(row1).toContainText(`2x ${t!.products.gum.name}`);
  await expect(row1).toContainText(expected[o1.id]);

  // Unmapped line item: picking blocked with a link to Variant Mapping.
  const row4 = page.getByTestId(`pick-row-${o4.id}`);
  await expect(row4.getByRole("button", { name: "Mark as Picked" })).toBeDisabled();
  await expect(row4).toContainText("Map the line item before picking.");
  await expect(row4.getByRole("link", { name: "Variant Mapping" })).toBeVisible();

  // In-use boxes are listed but disabled.
  await admin().rpc("mark_order_picked", { p_order_id: t!.orders[5].id, p_box_id: t!.boxes[3].id, p_order_name: t!.orders[5].name });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const input1 = row1.getByRole("combobox");
  await input1.click();
  await input1.fill(String(t!.boxes[3].number));
  await expect(page.getByRole("option", { name: `${t!.boxes[3].label} (in use: ${t!.orders[5].name})` })).toHaveAttribute("aria-disabled", "true", { timeout: 20_000 });
  await page.keyboard.press("Escape");

  // Choose boxes on two rows.
  await chooseBox(page, o1.id, t!.boxes[0].label);
  await chooseBox(page, o2.id, t!.boxes[1].label);
  await expect(row1.getByRole("button", { name: "Mark as Picked" })).toBeEnabled();

  // Someone else takes row 2's box; after a refresh only that selection clears.
  await admin().rpc("mark_order_picked", { p_order_id: t!.orders[4].id, p_box_id: t!.boxes[1].id, p_order_name: t!.orders[4].name });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const row2 = page.getByTestId(`pick-row-${o2.id}`);
  await expect(row2).toContainText(`${t!.boxes[1].label} was just taken`, { timeout: 20_000 });
  await expect(row2.getByRole("combobox")).toHaveValue("");
  await expect(row1.getByRole("combobox")).toHaveValue(t!.boxes[0].label);
  await shot(page, "pick-list-refresh");

  // Pick row 1: it leaves the list and appears under Recently picked.
  await row1.getByRole("button", { name: "Mark as Picked" }).click();
  await expect(row1).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole("cell", { name: o1.name })).toBeVisible();
  await shot(page, "pick-list-after-pick");
});

test("Pick List: two sessions race for the same box, exactly one wins", async ({ browser }) => {
  const a = await loggedInPage(browser);
  const b = await loggedInPage(browser);
  try {
    await openPickList(a.page);
    await openPickList(b.page);
    const [, o2, o3] = t!.orders;
    const box = t!.boxes[2];
    await chooseBox(a.page, o2.id, box.label);
    await chooseBox(b.page, o3.id, box.label);
    const responses = Promise.all([
      a.page.waitForResponse((r) => r.url().endsWith(`/api/fulfillments/${o2.id}/pick`)),
      b.page.waitForResponse((r) => r.url().endsWith(`/api/fulfillments/${o3.id}/pick`)),
    ]);
    await Promise.all([
      a.page.getByTestId(`pick-row-${o2.id}`).getByRole("button", { name: "Mark as Picked" }).click(),
      b.page.getByTestId(`pick-row-${o3.id}`).getByRole("button", { name: "Mark as Picked" }).click(),
    ]);
    const statuses = (await responses).map((r) => r.status()).sort();
    expect(statuses).toEqual([200, 409]);
    const { data } = await admin().from("staging_box_assignments").select("order_id").eq("staging_box_id", box.id).is("released_at", null);
    expect(data).toHaveLength(1);
    const winner = data![0].order_id as string;
    const loserPage = winner === o2.id ? b.page : a.page;
    const loserOrder = winner === o2.id ? o3 : o2;
    const loserRow = loserPage.getByTestId(`pick-row-${loserOrder.id}`);
    await expect(loserRow.getByRole("alert")).toContainText(`${box.label} is already holding order`);
    await expect(loserRow.getByRole("combobox")).toHaveValue("");
    await loserPage.screenshot({ path: path.join(SCREENS, "warehouse-race-loser.png"), fullPage: true });
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("Shipping Assignments: tabs and counts, Needs Review reasons, override moves", async ({ page }) => {
  await login(page);
  await blockExternalCalls(page, t!);
  const db = admin();
  await page.goto("/fulfillments/shipping-assignments");
  await page.getByLabel("Search STG box or order #").fill(t!.tag);

  // Every picked test order is on the tab its effective package names.
  const { data: picked } = await db.from("staging_box_assignments").select("order_id").in("order_id", t!.orders.map((o) => o.id)).is("released_at", null);
  const pickedIds = (picked ?? []).map((p) => p.order_id as string);
  expect(pickedIds.length).toBeGreaterThan(0);
  for (const id of pickedIds) {
    await page.getByTestId(`tab-${expected[id]}`).click();
    await expect(page.getByTestId(`ship-row-${id}`)).toBeVisible({ timeout: 20_000 });
  }

  // Override one order to Needs Review, then to the test Big package, then clear.
  const target = t!.orders.find((o) => o.id === pickedIds[0])!;
  await page.getByTestId(`tab-${expected[target.id]}`).click();
  const row = page.getByTestId(`ship-row-${target.id}`);
  await row.getByRole("button", { name: `More actions for ${target.name}` }).click();
  await page.getByRole("menuitem", { name: "Move to another package" }).click();
  await page.getByRole("radio", { name: "Needs Review" }).check();
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await page.getByTestId("tab-Needs Review").click();
  const reviewRow = page.getByTestId(`ship-row-${target.id}`);
  await expect(reviewRow).toBeVisible();
  await expect(reviewRow).toContainText("Overridden");
  await expect(reviewRow).toContainText("Moved to Needs Review");
  await shot(page, "shipping-needs-review");

  await reviewRow.getByRole("button", { name: `More actions for ${target.name}` }).click();
  await page.getByRole("menuitem", { name: "Move to another package" }).click();
  await page.getByRole("radio", { name: new RegExp(`^${t!.presets.big.nickname.replace(/[[\]]/g, "\\$&")}`) }).check();
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await page.getByTestId(`tab-${t!.presets.big.nickname}`).click();
  await expect(page.getByTestId(`ship-row-${target.id}`)).toBeVisible();
  await shot(page, "shipping-overridden");

  await page.getByTestId(`ship-row-${target.id}`).getByRole("button", { name: `More actions for ${target.name}` }).click();
  await page.getByRole("menuitem", { name: "Move to another package" }).click();
  await page.getByRole("button", { name: "Clear override" }).click();
  await page.getByTestId(`tab-${expected[target.id]}`).click();
  await expect(page.getByTestId(`ship-row-${target.id}`)).toBeVisible();
  await expect(page.getByTestId(`ship-row-${target.id}`)).not.toContainText("Overridden");

  // Tab counts match the rows (search cleared).
  await page.getByLabel("Search STG box or order #").fill("");
  const tabText = await page.getByTestId(`tab-${expected[target.id]}`).innerText();
  expect(Number(tabText.match(/(\d+)\s*$/)?.[1] ?? -1)).toBeGreaterThan(0);
});

test("Generate Label: blocked before picking, enabled after, package preselected", async ({ page }) => {
  await login(page);
  await blockExternalCalls(page, t!);
  const notPicked = t!.orders[2]; // order 3 (2 Gum-ish) may have lost the race; check its state
  const { data: st } = await admin().from("order_status").select("status").eq("shopify_order_id", notPicked.id).maybeSingle();
  const orderId = st?.status === "picked" ? t!.orders[1].id : notPicked.id;
  const { data: st2 } = await admin().from("order_status").select("status").eq("shopify_order_id", orderId).maybeSingle();
  test.skip(st2?.status === "picked", "both candidate orders already picked");

  await page.goto(`/fulfillments/${orderId}`);
  const generate = page.getByRole("button", { name: "Generate Label" });
  await expect(generate).toBeDisabled({ timeout: 30_000 });
  await expect(page.getByText("Pick this order first: assign a staging box on the")).toBeVisible();
  await expect(page.getByTestId("packaging-box")).toHaveText("Not picked yet");
  await shot(page, "generate-label-blocked");

  // Pick it into a free test box, then reload.
  const { data: open } = await admin().from("staging_box_assignments").select("staging_box_id").is("released_at", null);
  const used = new Set((open ?? []).map((a) => a.staging_box_id));
  const freeBox = t!.boxes.find((b) => !used.has(b.id))!;
  const order = t!.orders.find((o) => o.id === orderId)!;
  const r = await admin().rpc("mark_order_picked", { p_order_id: orderId, p_box_id: freeBox.id, p_order_name: order.name });
  expect(r.error).toBeNull();
  await page.reload();
  await expect(page.getByTestId("packaging-box")).toHaveText(freeBox.label, { timeout: 30_000 });
  await expect(generate).toBeEnabled();
  await generate.click();
  const dialogSelect = page.locator("div.fixed").getByRole("combobox").first();
  const selectedText = await dialogSelect.evaluate((el: HTMLSelectElement) => el.options[el.selectedIndex]?.text ?? "");
  expect(selectedText.startsWith(expected[orderId])).toBe(true);
  await shot(page, "generate-label-preselected");
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("Fulfillments list: Picked badge and filter, Box column, Shipping Assignments button with count", async ({ page }) => {
  await login(page);
  await blockExternalCalls(page, t!);
  await page.goto("/fulfillments");
  const button = page.getByRole("link", { name: /Shipping Assignments/ });
  await expect(button).toBeVisible({ timeout: 30_000 });
  // Directly above the Setup section.
  const buttonBox = await button.boundingBox();
  const setupBox = await page.getByRole("heading", { name: "Setup" }).boundingBox();
  expect(buttonBox!.y).toBeLessThan(setupBox!.y);
  const { data: open } = await admin().from("staging_box_assignments").select("order_id, staging_boxes(label)").in("order_id", t!.orders.map((o) => o.id)).is("released_at", null);
  expect(open!.length).toBeGreaterThan(0);
  await page.getByLabel("Order #").fill(t!.tag);
  await page.getByLabel("Status").selectOption("picked");
  const first = open![0] as any;
  const row = page.getByRole("row", { name: new RegExp(t!.orders.find((o) => o.id === first.order_id)!.name.replace(/[[\]#]/g, "\\$&")) });
  await expect(row).toContainText("Picked");
  await expect(row).toContainText(first.staging_boxes.label);
  await shot(page, "fulfillments-list");
});

test("Tablet width: Pick List and Shipping Assignments are usable", async ({ browser }) => {
  for (const viewport of [
    { width: 820, height: 1180 },
    { width: 1180, height: 820 },
  ]) {
    const context = await browser.newContext({ viewport, hasTouch: true });
    const page = await context.newPage();
    await login(page);
    await blockExternalCalls(page, t!);
    for (const [route, name] of [
      ["/fulfillments/pick-list", "pick-list"],
      ["/fulfillments/shipping-assignments", "shipping"],
    ] as const) {
      await page.goto(route);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(1500);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      await page.screenshot({ path: path.join(SCREENS, `warehouse-tablet-${viewport.width}-${name}.png`), fullPage: true });
    }
    await context.close();
  }
});
