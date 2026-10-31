import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests. All output (screenshots, traces, reports) goes to
 * .private/screens/, which is git-ignored and never deployed.
 *
 * Run against a running dev server:
 *   npm run dev            (in one terminal)
 *   npx playwright install chromium   (first time only)
 *   E2E_EMAIL=... E2E_PASSWORD=... npx playwright test
 * Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (from .env.local) to create
 * and clean up throwaway test records.
 */
export default defineConfig({
  testDir: "tests/e2e",
  outputDir: ".private/screens/test-output",
  reporter: [["list"], ["html", { outputFolder: ".private/screens/playwright-report", open: "never" }]],
  timeout: 120_000,
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
});
