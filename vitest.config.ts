import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: ["src/**/*.test.ts", "tests/unit/**/*.test.ts"],
    environment: "node",
    // Database tests run only when explicitly enabled (they need the service role and network).
    exclude: ["node_modules", ".private", "tests/e2e/**"],
  },
});
