/**
 * Strip murmur's own environment before any test module loads.
 *
 * The suite must not be able to tell whether the developer running it has
 * linked a real extension, joined a workstream, or pointed murmur at a state
 * dir. It could: six tests in extension-decide passed on the maintainer's
 * machine and failed everywhere else, on byte-identical files, because his
 * shell exported
 *
 *   MURMUR_STORE_MODULE=/Users/…/hacking/murmur/dist/extension/store.js
 *
 * which is exactly what the README tells you to do -- `murmur link pi` writes a
 * shim that sets it. `src/extension/murmur-pi.ts` prefers that variable over
 * the bare "@martintrojer/murmur/extension-store" specifier, and vitest mocks
 * by RESOLVED path, so `vi.doMock(<bare specifier>)` never applied: the real
 * store loaded, the mock counters stayed at 0, and the failure read as "the
 * extension is broken".
 *
 * The dangerous half is the other direction. In the maintainer's checkout the
 * pinned path coincidentally resolved to the same file as the bare specifier,
 * so the mock still matched and the tests went green -- while importing the
 * module from a DIFFERENT CHECKOUT than the one under test. A stale or broken
 * dist there would have been invisible. A suite that silently tests someone
 * else's build is worse than one that fails.
 *
 * Cleared suite-wide rather than stubbed per test, for three reasons:
 *
 *   - No test in this repo legitimately wants the ambient value. A per-test
 *     `vi.stubEnv` would have to be repeated in every test that ever mocks the
 *     store, and the one that forgets is the one that breaks -- which is the
 *     bug we just had, in a new shape.
 *   - It has to happen before the module under test is imported. A setup file
 *     runs before the test module in each worker, so there is no ordering to
 *     get wrong.
 *   - It fixes the whole class, not the one variable. Every name below is read
 *     by production code, two of them at MODULE SCOPE (`storeModule` and
 *     `muManaged` in murmur-pi.ts) where a test cannot intercept them at all.
 *
 * Tests that want a value set it themselves with `vi.stubEnv`, which is
 * unaffected: this only removes what the shell leaked in.
 */

// Read by src/: the store path the extension imports, the state and config
// dirs, the retention horizon, the pi home `link pi` writes into, and the four
// MU_* vars that decide whether an agent reports as orchestrated or human.
const OWNED = [
  "MURMUR_STORE_MODULE",
  "MURMUR_STATE_DIR",
  "MURMUR_CONFIG_DIR",
  "MURMUR_RETENTION_MS",
  "MURMUR_PI_HOME",
  "MU_MANAGED_AGENT",
  "MU_AGENT_NAME",
  "MU_WORKSTREAM",
  "MU_ROLE",
] as const;

for (const name of OWNED) delete process.env[name];

export { OWNED };
