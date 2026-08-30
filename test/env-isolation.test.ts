import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { CLEARED, OWNED, REDIRECTED } from "./setup.js";

/**
 * The suite must not be able to tell what the developer's shell exports.
 *
 * Six tests in extension-decide.test.ts passed on the maintainer's machine and
 * failed in every other checkout, on byte-identical files, because his shell
 * had MURMUR_STORE_MODULE set -- which is what `murmur link pi` tells you to
 * do. The tests mock the bare "@martintrojer/murmur/extension-store"
 * specifier; vitest mocks by resolved path; the variable made the extension
 * import a different path, so the mock never applied.
 *
 * These tests guard the rig itself, in the three ways it can rot.
 */

test("the ambient murmur environment is gone by the time a test runs", () => {
  // The wiring. If `setupFiles` is dropped from vitest.config.ts, or the setup
  // stops running before test modules, this fails in exactly the shells where
  // it matters: the ones that leaked a value in.
  //
  // Honest about its own limit -- in an already-clean shell this cannot fail,
  // which is why the two tests below do not depend on the environment at all.
  for (const name of CLEARED) {
    expect(process.env[name], `${name} leaked into the suite`).toBeUndefined();
  }
  // The redirected half is asserted by value, not by absence: unsetting these
  // hands the suite the developer's real state dir, so "gone" would be the
  // wrong contract. See test/state-isolation.test.ts.
  for (const [name, value] of Object.entries(REDIRECTED)) {
    expect(process.env[name], `${name} is not pointed at the sandbox`).toBe(value);
  }
});

test("the setup file rewrites the variables rather than merely reading them", () => {
  // The setup's own behaviour, independent of the shell: set every name, load
  // the module fresh, and require that it acted. A setup that imports cleanly
  // but changes nothing would pass the test above in a clean shell.
  for (const name of OWNED) vi.stubEnv(name, "/leaked/from/the/developer/shell");
  for (const name of OWNED) expect(process.env[name]).toBe("/leaked/from/the/developer/shell");

  vi.resetModules();
  return import("./setup.js").then(() => {
    for (const name of CLEARED) {
      expect(process.env[name], `${name} survived the setup`).toBeUndefined();
    }
    for (const name of Object.keys(REDIRECTED)) {
      expect(process.env[name], `${name} kept the leaked value`).not.toBe(
        "/leaked/from/the/developer/shell",
      );
    }
    vi.unstubAllEnvs();
  });
});

test("every environment variable src/ reads is one the rig controls", () => {
  // The drift guard, and the reason this is a list rather than a single delete.
  // MURMUR_STORE_MODULE is not special: `storeModule` and `muManaged` in
  // src/extension/murmur-pi.ts are read at MODULE SCOPE, where a test cannot
  // intercept them at all -- the value is baked in at import. Any future
  // MURMUR_*/MU_* read is the same hazard, and this fails the moment one is
  // added without being listed.
  //
  // Deliberately does NOT assert the reverse (that every OWNED name is still
  // read by src/): clearing a variable nothing reads is harmless, and pinning
  // it would make deleting a feature fail an unrelated test.
  const owned = new Set<string>(OWNED);
  const read = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts")) {
        // Widened past `process.env.X` on purpose, because the original pattern
        // could not see the two reads that caused the second half of the
        // incident. `MURMUR_PANE_OWNER` is a string constant
        // (decide.ts: OWNER_ENV) indexed as `env[OWNER_ENV]`, and TMUX /
        // TMUX_PANE / XDG_* reach src/ both as `process.env.TMUX_PANE` and as
        // `env.TMUX_PANE` on a passed-in environment. All three shapes now
        // count as "src/ reads this".
        for (const match of readFileSync(path, "utf8").matchAll(
          /(?:\benv\.|["'`])((?:MURMUR|MU|TMUX|XDG)[A-Z0-9_]*)/g,
        )) {
          if (match[1]) read.add(match[1]);
        }
      }
    }
  };
  walk("src");

  // Sanity: the scan found something, so an empty result cannot pass this.
  expect(read.size).toBeGreaterThan(0);
  expect([...read].sort()).toEqual([...read].filter((name) => owned.has(name)).sort());
});
