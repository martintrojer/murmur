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
 *
 * Removal is not always the safe move, though -- see REDIRECTED below, where
 * clearing a variable hands the suite the developer's live state instead of
 * isolating it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/**
 * Deleted outright: every variable whose absence is the safe answer.
 *
 * The store path the extension imports, the retention horizon, the four MU_*
 * vars that decide whether an agent reports as orchestrated or human -- and the
 * three that make the suite believe it is an agent in a pane.
 *
 * TMUX, TMUX_PANE and MURMUR_PANE_OWNER are the second half of the incident.
 * `tmux.currentWindow()` reads $TMUX_PANE and nothing else, by design (asking
 * tmux answers for whichever pane the server thinks is active, which is the
 * bug that made it the only signal). Inherited, it names the pane running
 * `npm test`, so `runNotify` with no --pane resolved a REAL agent's pane: the
 * notify-stdin tests wrote `blocked` rows and set tmux window badges for panes
 * %250/%251/%252 while the pi processes owning them were alive and working.
 * MURMUR_PANE_OWNER travels the same way and would make a test look nested.
 *
 * Tests that need a pane pass one explicitly -- `vi.stubEnv`, `fakeMux`, or a
 * child env -- and pane-ownership.test.ts stands up its own private tmux
 * server. None of them wants the ambient value.
 */
// MURMUR_RETENTION_MS and MURMUR_PANE_OWNER no longer exist in production --
// there is no retention horizon and no environment-borne ownership claim. They
// stay in this list deliberately: the rig's job is to make the suite independent
// of the developer's shell, and a stale export of a variable murmur once read
// costs nothing to keep clearing while a forgotten one costs a corrupted run.
const CLEARED = [
  "MURMUR_STORE_MODULE",
  "MURMUR_RETENTION_MS",
  "MU_MANAGED_AGENT",
  "MU_AGENT_NAME",
  "MU_WORKSTREAM",
  "MU_ROLE",
  "MURMUR_PANE_OWNER",
  "TMUX",
  "TMUX_PANE",
] as const;

/**
 * Redirected, not deleted: every variable that has a DANGEROUS default.
 *
 * This is the part a plain delete gets wrong, and it is why the first isolation
 * pass did not stop the damage. `stateDir()` falls back to
 * `$XDG_STATE_HOME/murmur`, else `~/.local/state/murmur` -- the developer's
 * real database. Unsetting MURMUR_STATE_DIR therefore aims the suite at
 * PRODUCTION, and the two states are indistinguishable from inside a test.
 *
 * So the fallbacks are moved instead: XDG_STATE_HOME and XDG_CONFIG_HOME so
 * the last resort is a temp dir, MURMUR_PI_HOME so `link pi` cannot write into
 * the real `~/.pi/agent/extensions`, and MURMUR_STATE_DIR/MURMUR_CONFIG_DIR so
 * a test that sets neither still gets a sandbox. Any test that wants its own
 * directory overrides these exactly as before.
 *
 * One directory per test FILE (a setup file runs once per file), created here
 * rather than per test, because a child spawned by a test inherits the
 * environment and must land in the same sandbox: the process boundary is where
 * the incident actually happened.
 */
// Recorded in the environment so a RE-IMPORT reuses it. The isolation tests
// re-import this module mid-test (`vi.resetModules()`) to assert what it does
// rather than what the shell happened to hold; a fresh mkdtemp there would
// repoint state under a test that is already running, and leave the first
// directory behind with no hook to sweep it.
const SANDBOX_ENV = "MURMUR_SUITE_SANDBOX";
const existing = process.env[SANDBOX_ENV];
const sandbox = existing ?? mkdtempSync(join(tmpdir(), "murmur-suite-"));
process.env[SANDBOX_ENV] = sandbox;

// Swept at the end of the file's run, by whichever import created it. Not
// load-bearing for isolation -- a leftover sandbox is harmless -- but without
// it a full run leaves one directory per test file behind, and a suite that
// litters is a suite whose temp dirs nobody notices growing.
if (!existing) afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const REDIRECTED = {
  MURMUR_STATE_DIR: join(sandbox, "state"),
  MURMUR_CONFIG_DIR: join(sandbox, "config"),
  MURMUR_PI_HOME: join(sandbox, "home"),
  XDG_STATE_HOME: join(sandbox, "xdg-state"),
  XDG_CONFIG_HOME: join(sandbox, "xdg-config"),
} as const;

for (const name of CLEARED) delete process.env[name];
for (const [name, value] of Object.entries(REDIRECTED)) process.env[name] = value;

/** Every variable the rig controls, cleared or redirected. The drift guard's set. */
const OWNED = [...CLEARED, ...(Object.keys(REDIRECTED) as (keyof typeof REDIRECTED)[])] as const;

export { CLEARED, OWNED, REDIRECTED };
