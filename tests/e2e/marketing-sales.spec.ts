/**
 * Browser tests for the Marketing Hub and line sheets (signed in as the
 * e2e Admin): the hub tabs, a claim through submit → approve, the post
 * Ready gate blocking an unapproved claim, a link asset, the risky-word
 * acknowledgement, and a line sheet from New → Save & Download (file name)
 * → Duplicate → Delete.
 *
 * Dev database only (assertDevDatabase), after marketing_sales.sql has been
 * run there. Invented "[TEST]" data only. Afterwards test posts, assets and
 * line sheets are archived or soft deleted and test claims retired (nothing
 * here is ever hard deleted). Screenshots: .private/screens/marketing-*.png.
 */
import { expect, test } from "@playwright/test";
import path from "node:path";
import { SCREENS, admin, login } from "./helpers";
import { assertBrowserOnDevDatabase, assertDevDatabase } from "./warehouseHelpers";

const tag = Math.random().toString(36).slice(2, 8);
const claimText = `[TEST] Claim ${tag}`;
const postTitle = `[TEST] Post ${tag}`;
const assetTitle = `[TEST] Reel ${tag}`;
const sheetName = `[TEST] Line sheet ${tag}`;

test.describe.configure({ mode: "serial" });
test.beforeAll(() => assertDevDatabase());
test.afterAll(async () => {
  const db = admin();
  const now = new Date().toISOString();
  await db.from("content_posts").update({ archived_at: now }).like("title", `[TEST]%${tag}%`);
  await db.from("marketing_assets").update({ status: "archived" }).like("title", `[TEST]%${tag}%`);
  await db.from("claims").update({ status: "retired", updated_by_name: "e2e cleanup" }).like("claim_text", `[TEST]%${tag}%`);
  await db.from("line_sheets").update({ deleted_at: now }).like("name", `[TEST]%${tag}%`).is("deleted_at", null);
});

test("the hub has its tabs (Settings for Admins) and the required notes", async ({ page }) => {
  await login(page);
  await assertBrowserOnDevDatabase(page);
  await page.goto("/growth/marketing");
  await expect(page.getByRole("heading", { name: "Marketing Hub", level: 1 })).toBeVisible();
  for (const t of ["Calendar", "Assets", "Claims", "Products", "Templates", "Settings"]) await expect(page.getByRole("tab", { name: t })).toBeVisible();
  await page.getByRole("tab", { name: "Claims" }).click();
  await expect(page).toHaveURL(/tab=claims/);
  await expect(page.getByTestId("claims-banner")).toContainText("Approval here does not replace a regulatory review.");
  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page.getByText("A starter list to catch wording that may need review. It is not a legal check.")).toBeVisible();
});

test("a draft claim blocks a Ready post until it is approved", async ({ page }) => {
  await login(page);
  await page.goto("/growth/marketing?tab=claims");
  await page.getByRole("button", { name: "New claim" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^Claim/).fill(claimText);
  await dialog.getByRole("button", { name: "Save as draft" }).click();
  await expect(page.getByRole("row", { name: new RegExp(claimText.replace(/[[\]]/g, "\\$&")) })).toContainText("Draft");

  await page.goto("/growth/marketing?tab=calendar");
  await page.getByRole("button", { name: "New post" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Title").fill(postTitle);
  await dialog.locator("#f-post-caption").fill("Fresh breath for the whole family.");
  await dialog.getByLabel(claimText).check();
  await dialog.getByLabel("Status").selectOption("ready");
  await expect(dialog.getByTestId("ready-blockers")).toContainText("aren't approved");
  await expect(dialog.getByRole("button", { name: "Save post" })).toBeDisabled();
  await page.screenshot({ path: path.join(SCREENS, "marketing-ready-gate.png") });
  await dialog.getByLabel("Status").selectOption("idea");
  await dialog.getByRole("button", { name: "Save post" }).click();
  await expect(page.getByRole("button", { name: postTitle })).toBeVisible();

  await page.goto("/growth/marketing?tab=claims");
  const row = page.getByRole("row", { name: new RegExp(claimText.replace(/[[\]]/g, "\\$&")) });
  await row.getByRole("button", { name: "Submit for review" }).click();
  await expect(row).toContainText("In review");
  await row.getByRole("button", { name: "Approve" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await expect(row).toContainText("Approved");

  await page.goto("/growth/marketing?tab=calendar");
  await page.getByRole("button", { name: postTitle }).click();
  dialog = page.getByRole("dialog");
  await dialog.locator("#f-post-caption").fill("This will cure everything.");
  await dialog.getByLabel("Status").selectOption("ready");
  await expect(dialog.getByTestId("risky-warning")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save post" })).toBeDisabled();
  await dialog.getByLabel("I have checked these words").check();
  await dialog.getByRole("button", { name: "Save post" }).click();
  await expect(page.getByRole("row", { name: new RegExp(postTitle.replace(/[[\]]/g, "\\$&")) })).toContainText("Ready");
});

test("add a link asset", async ({ page }) => {
  await login(page);
  await page.goto("/growth/marketing?tab=assets");
  await page.getByRole("button", { name: "Add asset" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Paste a link").check();
  await expect(dialog.getByText("You can upload MP4 or MOV files up to 200 MB, or paste a link for bigger videos.")).toBeVisible();
  await dialog.getByLabel("Link").fill("https://video.example.test/reel-a");
  await dialog.getByLabel(/^Title/).fill(assetTitle);
  await dialog.getByLabel("Type").selectOption("video");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("asset-card").filter({ hasText: assetTitle })).toBeVisible();
});

test("line sheet: new, save and download, duplicate, delete", async ({ page }) => {
  await login(page);
  await page.goto("/fulfillment/retail?tab=line-sheets");
  await expect(page.getByRole("tab", { name: "Line sheets" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("link", { name: "New line sheet" }).click();
  await page.getByLabel(/^Line sheet name/).fill(sheetName);
  await page.getByLabel("Prepared for").fill("[TEST] Store A");
  await page.getByRole("button", { name: "Add products" }).click();
  const picker = page.getByRole("dialog");
  await picker.getByRole("checkbox").first().check();
  await picker.getByRole("button", { name: /^Add/ }).click();
  await expect(page.getByTestId("ls-lines").locator("li")).toHaveCount(1);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save & Download" }).click();
  expect((await download).suggestedFilename()).toMatch(/^Line Sheet - .*Line sheet.*\.pdf$/);
  await expect(page).toHaveURL(/\/fulfillment\/retail\/line-sheets\/[0-9a-f-]{36}$/);
  await page.screenshot({ path: path.join(SCREENS, "marketing-line-sheet-view.png") });
  await page.getByRole("button", { name: "Duplicate" }).click();
  await expect(page).toHaveURL(/\/edit$/);
  await page.goto("/fulfillment/retail?tab=line-sheets");
  const rows = page.getByTestId("line-sheets-table").getByRole("row").filter({ hasText: tag });
  await expect(rows).toHaveCount(2);
  await rows.first().getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(rows).toHaveCount(1);
});
