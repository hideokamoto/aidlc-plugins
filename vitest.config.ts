import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "*/tests/**/*.test.ts"],
    exclude: ["node_modules/**", "*/dist/**", ".aidlc-cache/**"],
    // Each compose run copies a full runtime and shells out to bun.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
