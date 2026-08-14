import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      reporter: ["text", "json-summary"],
      reportsDirectory: "test/artifacts/coverage"
    }
  }
});
