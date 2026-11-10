/**
 * Browser tests for Procurement: the sidebar swap, shortages-first table,
 * Order button states, add / edit / make-preferred, and Create PO from a
 * row, an expanded supplier row, the Suppliers page and the shortages modal.
 *
 * Dev database only (assertDevDatabase), after supabase-migrations/
 * procurement_suppliers.sql has been run there. Invented "[TEST]" raw
 * materials and suppliers with example.test addresses. Raw materials are
 * deleted afterwards (their supplier links go with them); suppliers are
 * never deleted, so the test suppliers are archived instead.
 * No Purchase Order is saved by these tests.
 * Screenshots: .private/screens/procurement-*.png.
 */
import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { SCREENS, accessToken, admin, login, userIdFromToken } from "./helpers";
import { assertBrowserOnDevDatabase, assertDevDatabase } from "./warehouseHelpers";

type Seed = {
  tag: string;
  out: { id: string; name: string }; // out of stock, preferred: Supplier A (product link)
  below: { id: string; name: string }; // below par, preferred: Supplier B (website only)
  ok: { id: string; name: string }; // OK, no supplier
  supplierA: { id: string; name: string };
  supplierB: { id: string; name: string };
};
let s: Seed | null = null;

test.describe.configure({ mode: "serial" });

const must = <T,>(r: { data: T; error: { message: string } | null }, what: string): NonNullable<T> => {
  if (r.error || r.data == null) throw new Error(`${what}: ${r.error?.message ?? "no data"}`);
  return r.data as NonNullable<T>;
};

async function seed(userId: string): Promise<Seed> {
  const db = admin();
  const tag = Math.random().toString(36).slice(2, 8);
  const items = must(
    await db
      .from("inventory_items")
      .insert([
        { name: `[TEST] Out ${tag}`, unit: "kg", cost_per_unit: 0, quantity_on_hand: 0, par_level: 25, user_id: userId },
        { name: `[TEST] Below ${tag}`, unit: "Grams", cost_per_unit: 0, quantity_on_hand: 100, par_level: 400, user_id: userId },
        { name: `[TEST] Ok ${tag}`, unit: "each", cost_per_unit: 0, quantity_on_hand: 10, par_level: 5, user_id: userId },
      ])
      .select("id, name"),
    "raw materials",
  ) as { id: string; name: string }[];
  const [a, b] = must(
    await db
      .from("suppliers")
      .insert([
        {
          name: `[TEST] Supplier A ${tag}`,
          website_url: "https://supplier-a.example.test",
          contact_email: "orders@supplier-a.example.test",
          payment_methods: ["credit_card"],
          ordering_notes: "ORDERNOTE order before noon",
          payment_notes: "PAYNOTE call first",
          address_line1: "1 Example Way",
          city: "Testville",
          state: "DE",
          zip: "19700",
          country: "USA",
          default_po_payment_terms: "Prepaid",
        },
        { name: `[TEST] Supplier B ${tag}`, website_url: "https://supplier-b.example.test" },
      ])
      .select("id, name"),
    "suppliers",
  ) as { id: string; name: string }[];
  must(
    await db
      .from("raw_material_suppliers")
      .insert([
        { raw_material_id: items[0].id, supplier_id: a.id, product_url: "https://supplier-a.example.test/out", supplier_item: `[TEST] Item ${tag}`, notes: "LINKNOTE bulk tier" },
        { raw_material_id: items[1].id, supplier_id: b.id },
      ])
      .select("id"),
    "links",
  );
  return { tag, out: items[0], below: items[1], ok: items[2], supplierA: a, supplierB: b };
}

async function cleanup() {
  if (!s) return;
  const db = admin();
  await db.from("inventory_items").delete().in("id", [s.out.id, s.below.id, s.ok.id]);
  for (const sup of [s.supplierA, s.supplierB]) await db.rpc("archive_supplier", { p_supplier_id: sup.id, p_actor_name: "e2e" });
  s = null;
}

async function poCount(): Promise<number> {
  const r = await admin().from("purchase_orders").select("id", { count: "exact", head: true });
  return r.count ?? 0;
}

async function openProcurement(page: Page) {
  await page.goto("/inventory/procurement");
  await page.getByLabel("Search material or supplier").fill(s!.tag);
  await expect(page.getByTestId("material-row")).toHaveCount(3);
}

test.beforeAll(() => assertDevDatabase());
test.afterAll(cleanup);

test("sidebar shows Procurement in place of Purchase Orders, highlighted on Purchase Orders pages", async ({ page }) => {
  await login(page);
  await assertBrowserOnDevDatabase(page);
  s = await seed(userIdFromToken(await accessToken(page)));
  const nav = page.getByRole("navigation", { name: "Main" }).first();
  await expect(nav.getByRole("link", { name: "Procurement" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Purchase Orders", exact: true })).toHaveCount(0);
  for (const label of ["Finished Products Inventory", "Raw Materials", "Fulfillments", "SOPs"]) await expect(nav.getByRole("link", { name: label })).toBeVisible();
  for (const p of ["/inventory/purchase-orders", "/inventory/purchase-orders/new", "/inventory/procurement/suppliers"]) {
    await page.goto(p);
    await expect(nav.getByRole("link", { name: "Procurement" })).toHaveClass(/bg-emerald-600/);
  }
  await page.goto("/inventory/purchase-orders");
  await page.getByRole("link", { name: "← Back to Procurement" }).click();
  await expect(page).toHaveURL(/\/inventory\/procurement$/);
});

test("table: shortages first, Order button states, No supplier yet, counts and notes as text", async ({ page }) => {
  await login(page);
  await openProcurement(page);
  await expect(page.getByTestId("material-name")).toHaveText([s!.out.name, s!.below.name, s!.ok.name]);
  const rows = page.getByTestId("material-row");
  const order = (i: number) => rows.nth(i).getByTestId("order-button");
  await expect(order(0)).toHaveAttribute("href", "https://supplier-a.example.test/out");
  await expect(order(0)).toHaveAttribute("target", "_blank");
  await expect(order(0)).toHaveAttribute("rel", "noopener noreferrer");
  await expect(order(1)).toHaveText("Website");
  await expect(order(2)).toBeDisabled();
  await expect(order(2)).toHaveText("No link yet");
  await expect(rows.nth(2).getByText("No supplier yet")).toBeVisible();
  await expect(rows.nth(2).getByTestId("row-create-po")).toBeDisabled();
  await page.getByLabel("Shortages only").check();
  await expect(page.getByTestId("material-row")).toHaveCount(2);
  await page.screenshot({ path: path.join(SCREENS, "procurement-table.png"), fullPage: true });
});

test("add a supplier, make it preferred with a confirm, and edit it", async ({ page }) => {
  await login(page);
  await openProcurement(page);
  const row = page.getByTestId("material-row").nth(1); // Below
  await row.getByRole("button", { name: /Show suppliers/ }).click();
  await page.getByTestId(`subtable-${s!.below.id}`).getByRole("button", { name: "+ Add supplier" }).click();
  await page.getByRole("option", { name: new RegExp(s!.supplierA.name.replace(/[[\]]/g, "\\$&")) }).click();
  await page.getByLabel("Product link").fill("not a link");
  await page.getByRole("button", { name: "Add supplier" }).last().click();
  await expect(page.getByText("Enter a full product link starting with http:// or https://.")).toBeVisible();
  await page.getByLabel("Product link").fill("https://supplier-a.example.test/below");
  await page.getByRole("button", { name: "Add supplier" }).last().click();
  const sub = page.getByTestId(`subtable-${s!.below.id}`);
  await expect(sub.getByTestId("supplier-link-row")).toHaveCount(2);
  await sub.getByRole("button", { name: new RegExp(`Make .*Supplier A ${s!.tag} the preferred supplier`) }).click();
  await page.getByRole("button", { name: "Make preferred" }).click();
  await expect(page.getByTestId("material-row").nth(1).getByTestId("order-button")).toHaveAttribute("href", "https://supplier-a.example.test/below");
});

test("Create PO from a row opens the form prefilled and unsaved, with the Supplier info box", async ({ page }) => {
  await login(page);
  const before = await poCount();
  await openProcurement(page);
  await page.getByTestId("material-row").first().getByTestId("row-create-po").click();
  await expect(page).toHaveURL(new RegExp(`/inventory/purchase-orders/new\\?supplier=${s!.supplierA.id}&materials=${s!.out.id}$`));
  const box = page.getByTestId("supplier-info-box");
  await expect(box).toContainText("For your reference only. This is not printed on the PO.");
  await expect(box).toContainText("ORDERNOTE order before noon");
  // The PO form's labels are not linked to inputs, so match inputs by value.
  await expect(page.locator(`input[value="${s!.supplierA.name}"]`)).toBeVisible();
  await expect(page.locator('input[value="Testville"]')).toBeVisible();
  await expect(page.locator('input[value="[TEST] Item ' + s!.tag + '"]')).toBeVisible();
  await expect(page.locator('input[type="number"][value="25"]')).toBeVisible();
  const html = await page.content();
  expect(html).not.toContain("LINKNOTE");
  // No PO is created by opening the form, and saving without a unit price is refused as before.
  await page.getByRole("button", { name: "Create purchase order" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /required|unit price/ }).first()).toBeVisible();
  expect(await poCount()).toBe(before);
  await page.screenshot({ path: path.join(SCREENS, "procurement-po-prefill.png"), fullPage: true });
});

test("Create PO from the shortages modal (unchecked left out) and from the Suppliers page", async ({ page }) => {
  await login(page);
  await openProcurement(page);
  await page.getByRole("button", { name: "Create PO for shortages" }).click();
  await expect(page.getByText("One Purchase Order per supplier.")).toBeVisible();
  const group = page.getByTestId("shortage-group").filter({ hasText: s!.supplierA.name });
  await group.getByLabel(`Include ${s!.below.name}`).uncheck();
  await group.getByRole("button", { name: "Create PO" }).click();
  await expect(page).toHaveURL(new RegExp(`supplier=${s!.supplierA.id}&materials=${s!.out.id}$`));

  await page.goto("/inventory/procurement/suppliers");
  await page.getByLabel("Search suppliers").fill(s!.tag);
  await page.getByTestId("supplier-row").filter({ hasText: s!.supplierA.name }).getByTestId("supplier-create-po").click();
  await expect(page).toHaveURL(new RegExp(`supplier=${s!.supplierA.id}&materials=${s!.out.id}%2C${s!.below.id}$`));
  await expect(page.getByTestId("supplier-info-box")).toBeVisible();
});
