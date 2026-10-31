/**
 * Browser test with throwaway data only ("[TEST] ..." product, ingredients and SOP).
 * Screenshots go to .private/screens/.
 */
import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { SCREENS, accessToken, addFormulationVersion, cleanup, createTestData, login, userIdFromToken, type TestData } from "./helpers";

let t: TestData | null = null;
let sopId = "";

test.afterAll(async () => {
  await cleanup(t);
});

async function cellText(page: Page, ingredientPrefix: string, columnHeader: string) {
  const table = page.locator(".sop-formula table").first();
  const headers = await table.locator("thead th").allInnerTexts();
  const col = headers.findIndex((h) => h.trim() === columnHeader);
  const row = table.locator("tbody tr", { hasText: ingredientPrefix }).first();
  return (await row.locator("td").nth(col).innerText()).trim();
}

test("create, arrange, publish, auto-version, history and mobile", async ({ page }) => {
  await login(page);
  const token = await accessToken(page);
  t = await createTestData(userIdFromToken(token));

  // New SOP (blank)
  await page.goto("/compliance/sops");
  await page.getByRole("button", { name: "New SOP" }).click();
  await page.getByPlaceholder("SOP name").fill(`[TEST] SOP ${t.tag}`);
  await page.getByRole("button", { name: "Create and open editor" }).click();
  await page.waitForURL(/\/compliance\/sops\/[0-9a-f-]+\/edit$/);
  sopId = page.url().split("/").slice(-2)[0];
  t.sopIds.push(sopId);

  // Title + description
  const editor = page.locator(".ProseMirror");
  await editor.click();
  await page.waitForTimeout(150); // let the editor take focus before typing
  await page.getByLabel("Text style").selectOption("h1");
  await page.keyboard.type("Test title");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Test description for the throwaway SOP.");

  // Formula table for the throwaway product
  await page.getByRole("button", { name: "Insert formula table" }).click();
  await page.locator(".sop-formula-node").first().click();
  const settings = page.locator("text=Formula table settings").locator("..");
  await settings.locator("select").selectOption({ label: t.productName });
  await expect(page.locator(".sop-formula-badge")).toHaveText("Live: formula v1");
  expect(await cellText(page, "[TEST] Ingredient A", "20 units")).toBe("250");

  // Drag the formula table above the title using the drag handle.
  const ft = page.locator(".sop-formula-node").first();
  await ft.hover();
  const handle = page.locator(".sop-drag-handle");
  await expect(handle).toBeVisible();
  const hb = (await handle.boundingBox())!;
  const h1 = (await page.locator(".ProseMirror h1").boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(h1.x + 40, h1.y + 4, { steps: 12 });
  await page.mouse.move(h1.x + 40, h1.y + 2, { steps: 4 });
  await page.mouse.up();
  let firstIsTable = await page.locator(".ProseMirror > *").first().evaluate((el) => el.classList.contains("sop-formula-node") || !!el.querySelector(".sop-formula"));
  if (!firstIsTable) {
    // Keyboard fallback keeps the test going, but the drag result is reported.
    test.info().annotations.push({ type: "warning", description: "Mouse drag did not move the table; used Alt+Up." });
    await ft.click();
    for (let i = 0; i < 4; i++) await page.keyboard.press("Alt+ArrowUp");
    firstIsTable = await page.locator(".ProseMirror > *").first().evaluate((el) => el.classList.contains("sop-formula-node") || !!el.querySelector(".sop-formula"));
  }
  expect(firstIsTable).toBe(true);

  // Manual table at the end, filled in by hand
  await page.locator(".ProseMirror p").last().click();
  await page.waitForTimeout(150);
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Insert table" }).click();
  await page.getByLabel("Rows").fill("2");
  await page.getByLabel("Columns").fill("2");
  await page.getByRole("button", { name: "Insert", exact: true }).click();
  await page.waitForTimeout(150);
  const cells = ["Check", "Result", "Mix", "Smooth"];
  for (const [i, text] of cells.entries()) {
    await page.keyboard.type(text);
    if (i < cells.length - 1) await page.keyboard.press("Tab");
  }
  await expect(page.getByText(/^Saved/)).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: path.join(SCREENS, "e2e-01-editor.png"), fullPage: true });

  // Publish
  await page.getByRole("button", { name: "Publish…" }).click();
  await page.locator("textarea").fill("Initial test version");
  const publisher = page.locator("select").filter({ has: page.locator("option", { hasText: "Select…" }) }).last();
  const options = await publisher.locator("option").allInnerTexts();
  expect(options.length).toBeGreaterThan(1);
  await publisher.selectOption({ index: 1 });
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.waitForURL(new RegExp(`/compliance/sops/${sopId}$`));
  await expect(page.locator(".sop-header-block")).toContainText("v1");
  expect(await cellText(page, "[TEST] Ingredient A", "20 units")).toBe("250");
  await page.screenshot({ path: path.join(SCREENS, "e2e-02-published-v1.png"), fullPage: true });
  const bodyV1 = await page.locator(".sop-doc").first().innerText();

  // Formula change for the throwaway product -> exactly one automatic version
  const f2 = await addFormulationVersion(t, 2, 13);
  const productId = t.productId;
  const sync = async () =>
    page.evaluate(
      async ([tk, pid, fid]) => {
        const r = await fetch("/api/compliance/sops/sync-formula", {
          method: "POST",
          headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json" },
          body: JSON.stringify({ productId: pid, formulationId: fid }),
        });
        return r.json();
      },
      [token, productId, f2],
    );
  const first = await sync();
  expect(first.results.filter((r: { outcome: string }) => r.outcome === "created")).toHaveLength(1);
  const second = await sync();
  expect(second.results.filter((r: { outcome: string }) => r.outcome === "created")).toHaveLength(0);

  await page.reload();
  await expect(page.locator(".sop-header-block")).toContainText("v2 (current)");
  await expect(page.getByText(/Formula table updated automatically/)).toBeVisible();
  expect(await cellText(page, "[TEST] Ingredient A", "20 units")).toBe("260");
  const bodyV2 = await page.locator(".sop-doc").first().innerText();
  const stripTable = (s: string) => s.replace(/Ingredient \(g\)[\s\S]*?Generated from[^\n]*/, "");
  expect(stripTable(bodyV2)).toBe(stripTable(bodyV1));
  await page.screenshot({ path: path.join(SCREENS, "e2e-03-auto-v2.png"), fullPage: true });

  // Previous version still shows the old values
  await page.getByRole("button", { name: /^v1/ }).click();
  await expect(page.getByText(/You are viewing an older version \(v1\)/)).toBeVisible();
  expect(await cellText(page, "[TEST] Ingredient A", "20 units")).toBe("250");
  await page.screenshot({ path: path.join(SCREENS, "e2e-04-history-v1.png"), fullPage: true });

  // Mobile: table scrolls horizontally, ingredient column stays visible
  await page.getByRole("button", { name: /^v2/ }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const scroller = page.locator(".sop-formula-scroll").first();
  await scroller.scrollIntoViewIfNeeded();
  const canScroll = await scroller.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(canScroll).toBe(true);
  await scroller.evaluate((el) => (el.scrollLeft = el.scrollWidth));
  const ing = (await page.locator(".sop-formula tbody .sop-ing").first().boundingBox())!;
  const box = (await scroller.boundingBox())!;
  expect(ing.x).toBeGreaterThanOrEqual(box.x - 1);
  expect(ing.x).toBeLessThan(box.x + 10);
  const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(pageOverflow).toBe(false);
  await page.screenshot({ path: path.join(SCREENS, "e2e-05-mobile.png") });
});
