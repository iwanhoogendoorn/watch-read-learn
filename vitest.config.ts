import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Modules under test must stay obsidian-free, but later waves will want to
      // unit-test thin wrappers around the API. This stub keeps that possible.
      obsidian: fileURLToPath(new URL("./tests/mocks/obsidian.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // No network in tests, ever. Fixtures only.
    globals: false,
  },
});
