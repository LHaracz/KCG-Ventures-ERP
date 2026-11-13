/**
 * Browser tests for the Procurement Equipment tab, categories and listing
 * prices: tabs saved in the URL, the Equipment table (no stock columns,
 * natural sorting, category filter and counts, Missing price / No supplier
 * filters), adding equipment with a new category, choosing a supplier that
 * was added under Raw Materials, adding a brand new supplier from
 * equipment, the preferred star, Create PO from an equipment row and from
 * the subtable, Back to Procurement returning to the same tab, the
 * Suppliers page counts and archive, and the Raw Materials Price column
 * and Missing price toggle.
 *
 * Dev database only (assertDevDatabase), after procurement_suppliers.sql
 * and procurement_equipment_prices.sql have been run there. Invented
 * "[TEST]" data only. Nothing is deleted except the test raw materials;
 * test suppliers, equipment and categories are archived afterwards. No
 * Purchase Order is saved. Screenshots: .private/screens/equipment-*.png.
 */
import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { SCREENS, accessToken, admin, login, userIdFromToken } from "./helpers";
import { assertBrowserOnDevDatabase, assertDevDatabase } from "./warehouseHelpers";

type Seed = { tag: string; materialId: string; supplierA: { id: string; name: string }; scale2: string; scale10: string };
let s: Seed | null = null;
const created = { equipment: [] as string[], suppliers: [] as string[], categories: [] as string[] };

test.describe.configure({ mode: "serial" });

const must = <T,>(r: { data: T; error: { message: string } | null }, what: string): NonNullable<T> => {
  if (r.error || r.data == null) throw new Error(`${what}: ${r.error?.message ?? "no data"}`);
  return r.data as NonNullable<T>;
};
const esc = (t: string) => t.replace(/[[\]().*+?^$|\\]/g, "\\$&");

async function seed(userId: string): Promise<Seed> {
  const db = admin();
  const tag = Math.random().toString(36).slice(2, 8);
  const production = must(await db.from("equipment_categories").select("id").eq("name", "Production").is("archived_at", null).single(), "category") as { id: string };
  const mat = must(
    await db.from("inventory_items").insert({ name: `[TEST] Material ${tag}`, unit: "kg", cost_per_unit: 0, quantity_on_hand: 0, par_level: 10, user_id: userId }).select("id").single(),
    "raw material",
  ) as { id: string };
  const a = must(
    await db
      .from("suppliers")
      .insert({
        name: `[TEST] Supplier A ${tag}`,
        website_url: "https://supplier-a.example.test",
        ordering_notes: "ORDERNOTE before noon",
        address_line1: "1 Example Way",
        city: "Testville",
        state: "DE",
        zip: "19700",
        country: "USA",
      })
      .select("id, name")
      .single(),
    "supplier",
  ) as { id: string; name: string };
  created.suppliers.push(a.id);
  // Supplier A is first added under Raw Materials, with no price yet.
  must(await db.from("raw_material_suppliers").insert({ raw_material_id: mat.id, supplier_id: a.id }).select("id"), "raw listing");
  const items = must(
    await db
      .from("equipment_items")
      .insert([
        { name: `[TEST] ${tag} Scale 10`, category_id: production.id },
        { name: `[TEST] ${tag} Scale 2`, category_id: production.id },
      ])
      .select("id, name"),
    "equipment",
  ) as { id: string; name: string }[];
  created.equipment.push(...items.map((i) => i.id));
  return { tag, materialId: mat.id, supplierA: a, scale10: items[0].id, scale2: items[1].id };
}

async function cleanup() {
  const db = admin();
  for (const id of created.equipment) await db.rpc("archive_equipment_item", { p_equipment_id: id, p_actor_name: "e2e" });
  for (const id of created.suppliers) await db.rpc("archive_supplier_listings", { p_supplier_id: id, p_actor_name: "e2e" });
  for (const id of created.categories) await db.from("equipment_categories").update({ archived_at: new Date().toISOString() }).eq("id", id);
  if (s) await db.from("inventory_items").delete().eq("id", s.materialId);
  s = null;
}

async function poCount(): Promise<number> {
  return (await admin().from("purchase_orders").select("id", { count: "exact", head: true })).count ?? 0;
}

async function openEquipment(page: Page) {
  await page.goto("/inventory/procurement?tab=equipment");
  await page.getByLabel("Search equipment or supplier").fill(s!.tag);
}

test.beforeAll(() => assertDevDatabase());
test.afterAll(cleanup);

test("tabs are saved in the URL; the Equipment table has no stock columns and sorts naturally", async ({ page }) => {
  await login(page);
  await assertBrowserOnDevDatabase(page);
  s = await seed(userIdFromToken(await accessToken(page)));
  await page.goto("/inventory/procurement");
  await expect(page.getByTestId("tab-raw")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("tab-equipment").click();
  await expect(page).toHaveURL(/\/inventory\/procurement\?tab=equipment$/);
  await page.reload();
  await expect(page.getByTestId("tab-equipment")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Create PO for shortages" })).toHaveCount(0);
  await page.getByLabel("Search equipment or supplier").fill(s!.tag);
  await expect(page.getByTestId("equipment-name")).toHaveText([`[TEST] ${s!.tag} Scale 2`, `[TEST] ${s!.tag} Scale 10`]);
  const table = page.getByTestId("equipment-table");
  for (const word of ["On hand", "Par level", "Stock alert"]) await expect(table.getByText(word)).toHaveCount(0);
  await expect(page.getByTestId("equipment-row").first().getByText("No supplier yet")).toBeVisible();
  await expect(page.getByTestId("equipment-row").first().getByTestId("equipment-create-po")).toBeDisabled();
});

test("add equipment with a new category, then choose a supplier added under Raw Materials, with a price", async ({ page }) => {
  await login(page);
  await openEquipment(page);
  await page.getByRole("button", { name: "Add equipment" }).click();
  await page.getByLabel("Equipment name").fill(`[TEST] ${s!.tag} Label printer`);
  await page.getByLabel("Category").last().selectOption({ label: "+ New category…" });
  await page.getByLabel("New category name").fill(`[TEST] Lab ${s!.tag}`);
  await page.getByRole("button", { name: "Add equipment" }).last().click();
  // The Add supplier listing modal opens for the new item, with "Skip for now".
  await expect(page.getByRole("button", { name: "Skip for now" })).toBeVisible();
  await page.getByRole("option", { name: new RegExp(esc(s!.supplierA.name)) }).click();
  await page.getByLabel("Model or part number").fill("LP-42");
  await page.getByLabel("Price (USD)").fill("12.345678");
  await page.getByRole("button", { name: "Add supplier" }).last().click();
  await expect(page.getByText("Use at most 4 decimals.")).toBeVisible();
  await page.getByLabel("Price (USD)").fill("1299.5");
  await page.getByLabel("Price note").fill("each");
  await page.getByRole("button", { name: "Add supplier" }).last().click();
  const row = page.getByTestId("equipment-row").filter({ hasText: "Label printer" });
  await expect(row.getByTestId("price")).toHaveText("$1,299.50 each");
  const db = admin();
  const item = must(await db.from("equipment_items").select("id, category_id").eq("name", `[TEST] ${s!.tag} Label printer`).single(), "new item") as { id: string; category_id: string };
  created.equipment.push(item.id);
  created.categories.push(item.category_id);
  // The category filter lists the new category with its count.
  await expect(page.getByLabel("Category").first().locator("option", { hasText: `[TEST] Lab ${s!.tag} (1)` })).toHaveCount(1);
  await page.screenshot({ path: path.join(SCREENS, "equipment-table.png"), fullPage: true });
});

test("add a brand new supplier from equipment and move the star with a confirm", async ({ page }) => {
  await login(page);
  await openEquipment(page);
  const row = page.getByTestId("equipment-row").filter({ hasText: "Label printer" });
  await row.getByRole("button", { name: /Show suppliers/ }).click();
  const id = await row.getAttribute("data-equipment-id");
  const sub = page.getByTestId(`subtable-${id}`);
  await sub.getByRole("button", { name: "+ Add supplier" }).click();
  await page.getByLabel("New supplier").check();
  await page.getByLabel("Supplier name").fill(`[TEST] Supplier B ${s!.tag}`);
  await page.getByLabel("Website").fill("https://supplier-b.example.test");
  await page.getByRole("button", { name: "Add supplier" }).last().click();
  await expect(sub.getByTestId("supplier-link-row")).toHaveCount(2);
  const b = must(await admin().from("suppliers").select("id").eq("name", `[TEST] Supplier B ${s!.tag}`).single(), "supplier B") as { id: string };
  created.suppliers.push(b.id);
  await sub.getByRole("button", { name: new RegExp(`Make .*Supplier B ${s!.tag} the preferred supplier`) }).click();
  await page.getByRole("button", { name: "Make preferred" }).click();
  await expect(row.getByTestId("order-button")).toHaveText("Website");
  await expect(page.getByTestId("eq-count-missing_price")).toContainText(/missing price/);
});

test("Create PO from an equipment row and from the subtable: prefilled, unsaved, back to the Equipment tab", async ({ page }) => {
  await login(page);
  const before = await poCount();
  await openEquipment(page);
  const row = page.getByTestId("equipment-row").filter({ hasText: "Label printer" });
  const itemId = await row.getAttribute("data-equipment-id");
  await row.getByRole("button", { name: /Show suppliers/ }).click();
  await page.getByTestId(`subtable-${itemId}`).getByTestId("supplier-link-row").filter({ hasText: s!.supplierA.name }).getByTestId("subtable-create-po").click();
  await expect(page).toHaveURL(new RegExp(`/inventory/purchase-orders/new\\?supplier=${s!.supplierA.id}&equipment=${itemId}$`));
  await expect(page.locator('input[value="LP-42"]')).toBeVisible();
  await expect(page.locator('input[value="1299.5"]')).toBeVisible();
  await expect(page.locator('input[value="each"]')).toBeVisible();
  const box = page.getByTestId("supplier-info-box");
  await expect(box).toContainText("For your reference only. This is not printed on the PO.");
  await expect(box).toContainText("$1,299.50 each");
  expect(await page.content()).not.toContain("ORDERNOTE before noon\"");
  expect(await poCount()).toBe(before);
  await page.screenshot({ path: path.join(SCREENS, "equipment-po-prefill.png"), fullPage: true });
  await page.getByRole("link", { name: "← Back to Procurement" }).click();
  await expect(page).toHaveURL(/\/inventory\/procurement\?tab=equipment$/);

  await page.getByLabel("Search equipment or supplier").fill(s!.tag);
  await page.getByTestId("equipment-row").filter({ hasText: "Label printer" }).getByTestId("equipment-create-po").click();
  await expect(page).toHaveURL(/supplier=.*&equipment=/);
  expect(await poCount()).toBe(before);
});

test("Purchase Orders and Suppliers keep the tab; Suppliers shows both counts and archives both kinds", async ({ page }) => {
  await login(page);
  await openEquipment(page);
  await page.getByRole("link", { name: "Purchase Orders" }).click();
  await expect(page).toHaveURL(/\/inventory\/purchase-orders\?tab=equipment$/);
  await page.getByRole("link", { name: "← Back to Procurement" }).click();
  await expect(page).toHaveURL(/tab=equipment/);

  await page.getByRole("link", { name: "Suppliers" }).click();
  await page.getByLabel("Search suppliers").fill(s!.tag);
  const rowA = page.getByTestId("supplier-row").filter({ hasText: s!.supplierA.name });
  await expect(rowA.getByTestId("supplier-usage")).toHaveText("Used for 1 ingredient and 1 equipment item");
  await rowA.getByRole("button", { name: /Show ingredients/ }).click();
  await expect(page.getByTestId("supplier-equipment")).toContainText("Label printer");
  await expect(page.getByTestId("supplier-equipment").getByRole("link", { name: /Label printer/ })).toHaveAttribute("href", /tab=equipment&equipment=/);
  await rowA.getByRole("button", { name: "Archive" }).click();
  await expect(page.getByTestId("archive-counts")).toContainText("1 raw material listing and 1 equipment listing");
  await page.getByRole("button", { name: "Archive supplier" }).click();
  await expect(rowA).toHaveCount(0);
  await page.getByRole("link", { name: "← Back to Procurement" }).click();
  await expect(page).toHaveURL(/tab=equipment/);
});

test("Raw Materials: Price column and Missing price toggle", async ({ page }) => {
  await login(page);
  await page.goto("/inventory/procurement");
  await page.getByLabel("Search material or supplier").fill(s!.tag);
  await expect(page.getByRole("columnheader", { name: "Price" }).first()).toBeVisible();
  await page.getByLabel(/Missing price/).check();
  // Supplier A was archived above, so the test material has no preferred listing and drops out of "Missing price".
  await expect(page.getByTestId("material-row")).toHaveCount(0);
});
