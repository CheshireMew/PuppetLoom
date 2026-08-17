import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./scripts/lib/vitest-artifacts.mjs"],
    include: ["packages/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
});
