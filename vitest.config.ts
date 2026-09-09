import { defineConfig } from "vitest/config";

/**
 * Two files drive a REAL tmux server: `pane-ownership` and `mux-targets`. They
 * must not run beside each other.
 *
 * Each builds its own `-L` socket rig, so they do not share tmux state -- but
 * they still contend for the machine, and the symptom was pane-ownership's 5s
 * default timeout expiring while mux-targets was mid-spawn. Reproduced with ONLY
 * those two files selected (8 tests, nothing else running), which is what ruled
 * out "the machine happened to be busy" and named the real cause.
 *
 * `fileParallelism: false` for that pair via a separate project, so the rest of
 * the suite keeps running in parallel. A real tmux spawn also has no bounded
 * worst case, hence the longer `testTimeout` there and the 5s default
 * everywhere else -- where a slow test means a hang worth failing on.
 */
const TMUX_RIG_TESTS = ["test/pane-ownership.test.ts", "test/mux-targets.test.ts"];

const shared = {
  environment: "node" as const,
  pool: "forks" as const,
  // Runs in every worker before any test module is imported, which is the
  // only place murmur's module-scope env reads (murmur-pi.ts) can still be
  // influenced. See test/setup.ts for why the suite must not inherit these.
  setupFiles: ["test/setup.ts"],
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...shared,
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: TMUX_RIG_TESTS,
        },
      },
      {
        test: {
          ...shared,
          name: "tmux-rig",
          include: TMUX_RIG_TESTS,
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
