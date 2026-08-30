import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    // Runs in every worker before any test module is imported, which is the
    // only place murmur's module-scope env reads (murmur-pi.ts) can still be
    // influenced. See test/setup.ts for why the suite must not inherit these.
    setupFiles: ["test/setup.ts"],
  },
});
