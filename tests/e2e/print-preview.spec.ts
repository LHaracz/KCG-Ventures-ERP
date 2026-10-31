/**
 * Read-only print preview of one converted SOP (run after the migration is applied):
 *   E2E_PRINT_SOP_ID=<sop uuid> npx playwright test print-preview
 * Saves a PDF and a screenshot under .private/screens/ only. Changes nothing.
 */
import { expect, test } from "@playwright/test";
import path from "node:path";
import { SCREENS, login } from "./helpers";

const sopId = process.env.E2E_PRINT_SOP_ID;

test.skip(!sopId, "Set E2E_PRINT_SOP_ID to a converted SOP id.");

test("print preview of a converted SOP", async ({ page }) => {
  await login(page);
  await page.goto(`/compliance/sops/${sopId}`);
  await expect(page.locator(".sop-header-block")).toBeVisible();
  await expect(page.locator(".sop-doc")).toBeVisible();

  // Same steps as the Print button, without opening the browser dialog.
  const footer = await page.evaluate(() => {
    const header = document.querySelector(".sop-header-block")!;
    const dds = Array.from(header.querySelectorAll("dd")).map((d) => d.textContent?.trim() ?? "");
    const text = `${dds[0] && dds[0] !== "—" ? `${dds[0]} ` : ""}${(dds[1] ?? "").split(" ")[0]} · Printed ${new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" })} · Uncontrolled when printed. Verify the current version in the ERP.`;
    const st = document.createElement("style");
    st.textContent = `@media print { @page { @bottom-center { content: ${JSON.stringify(text)}; font-family: Arial, sans-serif; font-size: 7pt; color: #000; } } }`;
    document.head.appendChild(st);
    document.body.classList.add("sop-print-mode");
    return text;
  });
  expect(footer).toContain("Uncontrolled when printed");

  await page.emulateMedia({ media: "print" });
  // Tables must fit the printable width (Letter 8.5in - 2 x 0.6in = 7.3in = ~700px at 96dpi).
  const widest = await page.evaluate(() => Math.max(0, ...Array.from(document.querySelectorAll(".sop-doc table")).map((t) => t.getBoundingClientRect().width)));
  await page.setViewportSize({ width: 701, height: 1000 });
  const widestAtPrintWidth = await page.evaluate(() => Math.max(0, ...Array.from(document.querySelectorAll(".sop-doc table")).map((t) => t.getBoundingClientRect().width)));
  expect(widestAtPrintWidth).toBeLessThanOrEqual(701);
  test.info().annotations.push({ type: "info", description: `widest table: ${Math.round(widest)}px screen, ${Math.round(widestAtPrintWidth)}px at print width` });
  const repeats = await page.evaluate(() => Array.from(document.querySelectorAll(".sop-doc thead")).every((th) => getComputedStyle(th).display === "table-header-group"));
  expect(repeats).toBe(true);

  await page.screenshot({ path: path.join(SCREENS, "print-preview.png"), fullPage: true });
  await page.pdf({ path: path.join(SCREENS, "print-preview.pdf"), format: "Letter", preferCSSPageSize: true });
});
