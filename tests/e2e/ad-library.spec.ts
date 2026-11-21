/**
 * Browser tests for the Ad Library (signed in as the e2e Admin): the
 * Marketing Hub tab order, a topic, a reel with a new subtopic and its short
 * name, scheduling from the calendar (two platforms), the categorized Assets
 * tab, Best Times, and the Admin-only avoid list. The sidebar must not change.
 *
 * Dev database only (assertDevDatabase), after ad_library.sql and
 * marketing_naming.sql have been run there. Invented "[TEST]" data only.
 * Afterwards test posts, subtopics, topics and entries are archived (nothing
 * is hard deleted). Screenshots: .private/screens/adlib-*.png.
 */
import { expect, test } from "@playwright/test";
import path from "node:path";
import { SCREENS, admin, login } from "./helpers";
import { assertBrowserOnDevDatabase, assertDevDatabase } from "./warehouseHelpers";

const tag = Math.random().toString(36).slice(2, 8);
const pillarName = `[TEST] Topic ${tag}`;
const subName = `[TEST] Subtopic ${tag}`;
const phrase = `testphrase${tag}`;
const esc = (s: string) => s.replace(/[[\]]/g, "\\$&");

test.describe.configure({ mode: "serial" });
test.beforeAll(() => assertDevDatabase());
test.afterAll(async () => {
  const db = admin();
  const now = new Date().toISOString();
  const { data: pillars } = await db.from("content_pillars").select("id").like("name", `[TEST]%${tag}%`);
  const ids = (pillars ?? []).map((p: { id: string }) => p.id);
  if (ids.length) {
    const { data: posts } = await db.from("premade_posts").select("id").in("pillar_id", ids);
    const postIds = (posts ?? []).map((p: { id: string }) => p.id);
    if (postIds.length) await db.from("content_posts").update({ archived_at: now }).in("premade_post_id", postIds);
    await db.from("premade_posts").update({ archived_at: now }).in("pillar_id", ids);
    await db.from("content_series").update({ archived_at: now }).in("pillar_id", ids);
    await db.from("content_pillars").update({ archived_at: now }).in("id", ids);
  }
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

test("add a topic, then a reel with a new subtopic: it is named {letter}A-1", async ({ page }) => {
  await login(page);
  await page.goto("/growth/marketing?tab=pillars");
  await page.getByRole("button", { name: "Add topic" }).click();
  let dialog = page.getByRole("dialog");
  const letter = await dialog.getByLabel("Letter").inputValue();
  await dialog.getByLabel(/^Name/).fill(pillarName);
  await dialog.getByRole("button", { name: /^Save/ }).click();
  await expect(page.getByRole("row", { name: new RegExp(esc(pillarName)) })).toBeVisible();

  await page.goto("/growth/marketing?tab=library");
  await page.getByRole("button", { name: "New reel" }).click();
  dialog = page.getByRole("dialog");
  const topic = dialog.getByLabel("Main topic");
  await topic.selectOption((await topic.locator("option", { hasText: pillarName }).getAttribute("value"))!);
  await dialog.getByLabel("Subtopic").selectOption("__new");
  await dialog.getByLabel(/New subtopic name/).fill(subName);
  await expect(dialog.getByTestId("next-name")).toContainText(`${letter}A-1`);
  await dialog.getByLabel(/^Hook/).fill("A hook for testing");
  await dialog.getByRole("button", { name: /Add beat/ }).click();
  await dialog.getByLabel("Beat 1", { exact: true }).fill("Open on the product");
  await dialog.locator("#f-pm-caption").fill("A caption for testing");
  await dialog.getByRole("button", { name: /^Save/ }).click();
  await expect(page.getByTestId("toast")).toContainText(`Saved ${letter}A-1`);
  await page.screenshot({ path: path.join(SCREENS, "adlib-library.png") });
});

test("schedule the reel from the calendar on two platforms", async ({ page }) => {
  await login(page);
  await page.goto("/growth/marketing?tab=calendar");
  await page.getByRole("button", { name: "New post" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder("Search by name or caption").fill("A caption for testing");
  await dialog.getByTestId("schedule-post-list").getByRole("button").first().click();
  await dialog.getByLabel("Add platform").selectOption("tiktok");
  await dialog.getByLabel(/^Date/).fill("2027-01-05");
  const anyway = dialog.getByLabel("Schedule anyway");
  if (await anyway.isVisible()) await anyway.check();
  await dialog.getByRole("button", { name: /Schedule 2 entries/ }).click();
  await expect(page.getByTestId("toast")).toContainText("2 platforms");
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
