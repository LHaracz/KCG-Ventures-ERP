/**
 * Browser tests for Retail (Admin only): the sidebar item (Marketing & Sales), adding a
 * retailer with consignment terms (live "Retailer keeps X%"), the price
 * list, a new invoice with a custom line, the Shopify order number check,
 * Download PDF (file name), Delete and Restore.
 *
 * Dev database only (assertDevDatabase), after retail_invoices.sql has been
 * run there. Invented "[TEST]" data only. Afterwards test invoices are
 * deleted (soft, VOID) and test retailers archived; invoice numbers used by
 * the test are never reused. Screenshots: .private/screens/retail-*.png.
 */
import { expect, test } from "@playwright/test";
import path from "node:path";
import { SCREENS, admin, login } from "./helpers";
import { assertBrowserOnDevDatabase, assertDevDatabase } from "./warehouseHelpers";

const tag = Math.random().toString(36).slice(2, 8);
const retailerName = `[TEST] Retailer ${tag}`;
const order = `T-${tag}`;
const created = { retailers: [] as string[], invoices: [] as string[] };

test.describe.configure({ mode: "serial" });
test.beforeAll(() => assertDevDatabase());
test.afterAll(async () => {
  const db = admin();
  for (const id of created.invoices) await db.from("invoices").update({ deleted_at: new Date().toISOString() }).eq("id", id).is("deleted_at", null);
  for (const id of created.retailers) await db.from("retailers").update({ archived_at: new Date().toISOString() }).eq("id", id).is("archived_at", null);
});

test("Retail is in the Marketing & Sales group for Admins, after Marketing Hub", async ({ page }) => {
  await login(page);
  await assertBrowserOnDevDatabase(page);
  await page.goto("/fulfillment/retail");
  const nav = page.getByRole("navigation");
  const labels = (await nav.getByRole("link").allInnerTexts()).map((l) => l.trim());
  const i = labels.indexOf("Marketing Hub");
  expect(i).toBeGreaterThan(-1);
  expect(labels.slice(i + 1, i + 4)).toEqual(["Retail", "Sales Data", "Sales Stats"]);
  await expect(page.getByRole("heading", { name: "Retail", level: 1 })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Retailers" })).toHaveAttribute("aria-selected", "true");
});

test("add a retailer with consignment terms", async ({ page }) => {
  await login(page);
  await page.goto("/fulfillment/retail");
  await page.getByRole("button", { name: "Add retailer" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^Retailer name/).fill(retailerName);
  await dialog.getByLabel("Contact email").fill(`buyer-${tag}@retailer-a.example.test`);
  await dialog.getByLabel(/^Address line 1/).first().fill("1 Market Way");
  await dialog.getByLabel(/^City/).first().fill("Shopton");
  await dialog.getByLabel(/^State/).first().fill("PA");
  await dialog.getByLabel(/^ZIP/).first().fill("19100");
  await dialog.getByLabel("Payment terms").first().selectOption("consignment");
  await dialog.getByLabel(/Our share of retail price/).first().fill("70");
  await expect(dialog.getByText("Retailer keeps 30%")).toBeVisible();
  await dialog.getByLabel(/Settlement schedule/).first().selectOption("monthly");
  await dialog.getByRole("button", { name: "Add retailer" }).click();
  await expect(page).toHaveURL(/\/fulfillment\/retail\/retailers\/[0-9a-f-]{36}$/);
  created.retailers.push(page.url().split("/").pop()!);
  await expect(page.getByRole("heading", { name: retailerName })).toBeVisible();
  await expect(page.getByText(/receives 70% of the retail price/)).toBeVisible();
  await page.screenshot({ path: path.join(SCREENS, "retail-retailer.png"), fullPage: true });
});

test("new invoice: order number required and unique, saved with a number, downloaded, deleted and restored", async ({ page }) => {
  await login(page);
  await page.goto(`/fulfillment/retail/invoices/new?retailer=${created.retailers[0]}`);
  // Switch to Net 30 for this invoice and add a custom line.
  await page.getByLabel("Payment terms").selectOption("net");
  await page.getByLabel("Line 1 description").fill("[TEST] Custom item");
  await page.getByLabel("Line 1 quantity").fill("2");
  await page.getByLabel(/Line 1 unit price/).fill("10");
  await page.getByRole("button", { name: "Save invoice" }).click();
  await expect(page.getByText("Enter the Shopify order number.").first()).toBeVisible();
  await page.getByLabel(/^Shopify order #/).fill(order);
  await page.getByRole("button", { name: "Save invoice" }).click();
  await expect(page).toHaveURL(/\/fulfillment\/retail\/invoices\/[0-9a-f-]{36}\?created=1$/);
  const id = new URL(page.url()).pathname.split("/").pop()!;
  created.invoices.push(id);
  const heading = await page.getByRole("heading", { level: 1 }).innerText();
  const number = heading.split(" ·")[0].trim();
  expect(number).toMatch(/^[A-Z0-9-]+-\d{4}-\d{3,}$/);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PDF" }).click();
  expect((await download).suggestedFilename()).toBe(`${number} - Order ${order} - TEST Retailer ${tag}.pdf`);
  await expect(page.getByText("Never downloaded.")).toHaveCount(0);
  await page.screenshot({ path: path.join(SCREENS, "retail-invoice.png"), fullPage: true });

  // The same order number is refused on a second invoice.
  await page.goto(`/fulfillment/retail/invoices/new?retailer=${created.retailers[0]}`);
  await page.getByLabel(/^Shopify order #/).fill(order.toLowerCase());
  await expect(page.getByText(new RegExp(`Order ${order} already has an invoice \\(${number}`, "i"))).toBeVisible();

  // Delete (VOID), then restore.
  await page.goto(`/fulfillment/retail/invoices/${id}`);
  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete invoice" }).click();
  await expect(page.getByText("Deleted (PDF shows VOID)")).toBeVisible();
  await page.getByRole("button", { name: "Restore" }).click();
  await page.getByRole("button", { name: "Restore invoice" }).click();
  await expect(page.getByText("Deleted (PDF shows VOID)")).toHaveCount(0);
});
