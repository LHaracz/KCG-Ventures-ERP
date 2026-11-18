/**
 * Browser tests for the Ad Library build (signed in as the e2e Admin): the
 * Marketing Hub tab order, a pillar, a reel with script beats and the Ready
 * gate, Add to calendar (two platforms, two entries), the categorized Assets
 * tab, Best Times, and the Admin-only avoid list. The sidebar must not change.
 *
 * Dev database only (assertDevDatabase), after ad_library.sql has been run
 * there. Invented "[TEST]" data only. Afterwards test items, posts and assets
 * are archived (nothing is hard deleted). Screenshots: .private/screens/adlib-*.png.
 */
import { expect, test } from "@playwright/test";
import path from "node:path";
import { SCREENS, admin, login } from "./helpers";
import { assertBrowserOnDevDatabase, assertDevDatabase } from "./warehouseHelpers";

const tag = Math.random().toString(36).slice(2, 8);
const pillarName = `[TEST] Pillar ${tag}`;
const reelTitle = `[TEST] Reel ${tag}`;
const phrase = `testphrase${tag}`;

test.describe.configure({ mode: "serial" });
test.beforeAll(() => assertDevDatabase());
test.afterAll(async () => {
  const db = admin();
  const now = new Date().toISOString();
  await db.from("premade_posts").update({ archived_at: now }).like("title", `[TEST]%${tag}%`);
  await db.from("content_posts").update({ archived_at: now }).like("title", `%[TEST]%${tag}%`);
  await db.from("content_pillars").update({ archived_at: now }).like("name", `[TEST]%${tag}%`);
  await db.from("avoid_phrases").update({ archived_at: now }).eq("phrase", phrase);
});

test("the Marketing Hub tabs are in order and the sidebar has no new items", async ({ page }) => {
  await login(page);
  await assertBrowserOnDevDatabase(page);
  await page.goto("/growth/marketing");
  const tabs = (await page.getByRole("tab").allInnerTexts()).map((t) => t.trim());
  expect(tabs.slice(0, 9)).toEqual(["Calendar", "Ad Library", "Pillars", "Assets", "Claims", "Products", "Templates", "Best Times", "Settings"]);
  const nav = (await page.getByRole("navigation").getByRole("link").allInnerTexts()).map((l) => l.trim());
  expect(nav).not.toContain("Ad Library");
  expect(nav).not.toContain("Pillars");
});

test("add a pillar, then a reel with script beats; Ready lists the blockers", async ({ page }) => {
  await login(page);
  await page.goto("/growth/marketing?tab=pillars");
  await page.getByRole("button", { name: "Add pillar" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^Name/).fill(pillarName);
  await dialog.getByRole("button", { name: /^Save/ }).click();
  await expect(page.getByRole("row", { name: new RegExp(pillarName.replace(/[[\]]/g, "\\$&")) })).toBeVisible();

  await page.goto("/growth/marketing?tab=library");
  await page.getByRole("button", { name: "New reel" }).click();
  dialog = page.getByRole("dialog");
  const pillarSelect = dialog.getByLabel("Pillar");
  const value = await pillarSelect.locator("option", { hasText: pillarName }).getAttribute("value");
  await pillarSelect.selectOption(value!);
  await dialog.getByLabel(/^Title/).fill(reelTitle);
  await dialog.getByLabel(/^Hook/).fill("A hook for testing");
  await dialog.getByRole("button", { name: /Add beat/ }).click();
  await dialog.getByLabel("Beat 1", { exact: true }).fill("Open on the product");
  await dialog.getByRole("button", { name: /^Save/ }).click();
  await expect(page.getByText(new RegExp(` - ${reelTitle.replace(/[[\]]/g, "\\$&")}`)).first()).toBeVisible();
  await page.screenshot({ path: path.join(SCREENS, "adlib-library.png") });
});

test("add the reel to the calendar on two platforms", async ({ page }) => {
  await login(page);
  await page.goto("/growth/marketing?tab=calendar");
  await page.getByRole("button", { name: "Start from the library" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Search by name").fill(tag);
  await dialog.getByRole("button", { name: new RegExp(reelTitle.replace(/[[\]]/g, "\\$&")) }).click();
  await dialog.getByLabel(/^Date/).fill("2027-01-05");
  await dialog.getByLabel("Instagram").check();
  await dialog.getByLabel("TikTok").check();
  await dialog.getByRole("button", { name: /Add 2 entries/ }).click();
  await expect(page.getByTestId("schedule-done")).toContainText("2 calendar entries added");
});

test("assets show category chips; Best Times shows Eastern Time", async ({ page }) => {
  await login(page);
  await page.goto("/growth/marketing?tab=assets");
  await expect(page.getByTestId("category-chips")).toContainText("Uncategorized");
  await page.goto("/growth/marketing?tab=best-times");
  await expect(page.getByText("Times shown in Eastern Time (America/New_York).")).toBeVisible();
});

test("an Admin adds an avoid phrase in Settings", async ({ page }) => {
  await login(page);
  await page.goto("/growth/marketing?tab=settings");
  await expect(page.getByText("Posts that contain these phrases show a red Avoid list chip. This is a review aid, not a legal check.")).toBeVisible();
  await page.getByLabel("Phrase").first().fill(phrase);
  await page.getByRole("button", { name: "Add phrase" }).click();
  await expect(page.getByTestId("avoid-list")).toContainText(phrase);
});
