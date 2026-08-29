import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { driverFromEnv, endState } from "../src/extension/decide.js";

/**
 * Wait until `condition` holds, or fail loudly.
 *
 * The handlers are `void enqueue(...)`, so they return before their work runs,
 * and that work awaits a dynamic import -- which needs an unknown number of
 * macrotask turns to settle. A fixed `setTimeout(0)` looked like it worked and
 * failed roughly one run in ten: a race in the TEST, which is worse than a
 * failing test because it teaches people to re-run.
 */
async function until(condition: () => boolean, _label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // Returns rather than throws, deliberately. Throwing here would make a
  // regression fail inside this helper instead of at the assertion that
  // describes it -- and worse, a mutation that stops the work happening at all
  // would be "caught" by a timeout message that says nothing about the
  // behaviour. Let the caller's expect() report it.
}

test("agent_end reports done only when unseen and not mu-managed", () => {
  expect(endState(false, false)).toBe("done");
  expect(endState(true, false)).toBe("cleared");
  expect(endState(false, true)).toBe("cleared");
});

test("driver is orchestrated only under a supervisor", () => {
  expect(driverFromEnv({ MU_MANAGED_AGENT: "1" })).toBe("orchestrated");
  expect(driverFromEnv({ MU_AGENT_NAME: "worker-1" })).toBe("orchestrated");
  expect(driverFromEnv({})).toBe("human");
});

test("link pi pins the store import to an absolute, resolvable path", () => {
  // Regression: the extension is copied into ~/.pi/agent/extensions, where a
  // bare "@martintrojer/murmur/extension-store" specifier cannot resolve — not
  // even for a global install. Unpinned, every append silently no-ops: the
  // tmux badge still paints, so nothing looks broken while the log stays empty.
  const home = mkdtempSync(join(tmpdir(), "murmur-link-"));
  execFileSync(process.execPath, [join(process.cwd(), "dist", "cli.js"), "link", "pi"], {
    env: { ...process.env, MURMUR_PI_HOME: home },
    stdio: "ignore",
  });
  const source = readFileSync(join(home, ".pi", "agent", "extensions", "murmur.ts"), "utf8");
  const match = source.match(/storeModule = "([^"]+)"/);
  expect(match).not.toBeNull();
  const pinned = match?.[1] ?? "";
  expect(pinned.startsWith("/")).toBe(true);
  expect(existsSync(pinned)).toBe(true);
});

test("a failed append closes the store it is dropping", async () => {
  // Regression: the catch assigned `store = null` without closing, so a
  // recurring transient write failure leaked one SQLite connection and its WAL
  // read state per event, inside a pi process that can run for days. The next
  // event opened a fresh handle and session_shutdown could only close that one.
  let opened = 0;
  let closed = 0;

  // The extension imports its store by the published specifier, which is how
  // it resolves once copied into ~/.pi/agent/extensions.
  vi.doMock("@martintrojer/murmur/extension-store", () => ({
    loadIdentity: () => ({ host_id: "H", display_name: "h" }),
    openStore: () => {
      opened += 1;
      return {
        append: () => {
          throw new Error("database is locked");
        },
        close: () => {
          closed += 1;
        },
      };
    },
  }));

  // currentWindow() returns null outside a pane, which exits the extension
  // before it ever touches a store.
  vi.doMock("../src/mux.js", () => ({
    tmux: {
      currentWindow: () => ({
        session: "$0",
        window: "@1",
        pane: "%1",
        session_name: null,
        window_name: null,
      }),
      setState: () => {},
    },
  }));

  vi.resetModules();
  const { default: murmurPi } = await import("../src/extension/murmur-pi.js");

  const handlers = new Map<string, () => void | Promise<void>>();
  murmurPi({ on: (event, handler) => handlers.set(event, handler) });

  // agent_start/agent_end are fire-and-forget (`void enqueue`), so drive the
  // one handler that awaits its queue.
  await handlers.get("session_shutdown")?.();

  // One handle opened, and the failed append closed it rather than orphaning
  // it. Before the fix this was opened=1, closed=0.
  expect(opened).toBe(1);
  expect(closed).toBe(1);

  vi.doUnmock("@martintrojer/murmur/extension-store");
  vi.doUnmock("../src/mux.js");
  vi.resetModules();
});

test("a transient write failure does not silence the agent for the rest of its life", async () => {
  // Regression, observed on a real agent: it stopped reporting mid-session and
  // read as idle for minutes while it was working.
  //
  // getStore cached `null` to mean "murmur is absent, stop trying", and
  // dropStore assigned that same `null` after a failed write. So one transient
  // failure -- a lock held by a concurrent writer is enough -- latched the
  // cache off, and every later event was dropped for the life of the process.
  // Silently: the tmux badge is set before the append, so the window still
  // looked right while the log went nowhere.
  let opened = 0;
  const appended: string[] = [];
  let failNext = true;

  vi.doMock("@martintrojer/murmur/extension-store", () => ({
    loadIdentity: () => ({ host_id: "H", display_name: "h" }),
    openStore: () => {
      opened += 1;
      return {
        append: (event: { state: string }) => {
          // Fail once, then work -- the shape of a lock contention, not of a
          // missing install.
          if (failNext) {
            failNext = false;
            throw new Error("database is locked");
          }
          appended.push(event.state);
        },
        close: () => {},
      };
    },
  }));

  vi.doMock("../src/mux.js", () => ({
    tmux: {
      currentWindow: () => ({
        session: "$0",
        window: "@1",
        pane: "%1",
        session_name: null,
        window_name: null,
      }),
      setState: () => {},
    },
  }));

  vi.resetModules();
  const { default: murmurPi } = await import("../src/extension/murmur-pi.js");

  const handlers = new Map<string, () => void | Promise<void>>();
  murmurPi({ on: (event, handler) => handlers.set(event, handler) });

  // First turn: the append throws and the handle is dropped. Waited on the
  // observable effect (the store was opened) rather than on a timer.
  await handlers.get("agent_start")?.();
  await until(() => opened === 1, "first store open");
  expect(appended).toEqual([]);

  // Second turn: this is the assertion that failed before the fix. The store
  // must be reopened and the event recorded, not skipped because a previous
  // write failed.
  await handlers.get("agent_start")?.();
  await until(() => appended.length > 0, "second turn's append");
  expect(appended).toEqual(["working"]);
  expect(opened).toBe(2);

  vi.doUnmock("@martintrojer/murmur/extension-store");
  vi.doUnmock("../src/mux.js");
  vi.resetModules();
});

test("a missing murmur is given up on after one attempt, not retried per event", async () => {
  // The other half of the same decision, and why dropStore could not simply
  // always retry. When the import itself fails murmur is not installed, which
  // does not become false later in the process, so retrying would pay a failed
  // dynamic import on every turn forever.
  let imports = 0;

  vi.doMock("@martintrojer/murmur/extension-store", () => {
    imports += 1;
    throw new Error("Cannot find module");
  });

  vi.doMock("../src/mux.js", () => ({
    tmux: {
      currentWindow: () => ({
        session: "$0",
        window: "@1",
        pane: "%1",
        session_name: null,
        window_name: null,
      }),
      setState: () => {},
    },
  }));

  vi.resetModules();
  const { default: murmurPi } = await import("../src/extension/murmur-pi.js");

  const handlers = new Map<string, () => void | Promise<void>>();
  murmurPi({ on: (event, handler) => handlers.set(event, handler) });

  for (let turn = 0; turn < 3; turn += 1) {
    await handlers.get("agent_start")?.();
    // The first turn must have tried and given up before the next is queued,
    // or "one attempt" would pass simply because turns 2 and 3 had not run.
    await until(() => imports === 1, `import attempt by turn ${turn + 1}`);
  }

  // One attempt, however many events arrive.
  expect(imports).toBe(1);

  vi.doUnmock("@martintrojer/murmur/extension-store");
  vi.doUnmock("../src/mux.js");
  vi.resetModules();
});

test("a pane moved to another window keeps its identity and stops badging the old one", async () => {
  // tmux keeps a pane's id when it moves between windows (move-pane,
  // break-pane, or a keybinding wrapping them) and changes only the window id.
  // Verified against a real tmux: pane %0 went from @0 to @1.
  //
  // Resolving the window once at startup broke three things at once: the badge
  // was painted on the window the agent had left, every later event recorded a
  // window the agent was no longer in (so a jump went to the wrong place), and
  // `liveWindows()` -- which prunes rows whose window is gone -- deleted the
  // agent as dead when the old window was closed.
  const appended: { window: string; agent_id: string }[] = [];
  const badges: [string, string | null][] = [];

  vi.doMock("@martintrojer/murmur/extension-store", () => ({
    loadIdentity: () => ({ host_id: "H", display_name: "h" }),
    openStore: () => ({
      append: (event: { window: string; agent_id: string }) => {
        appended.push({ window: event.window, agent_id: event.agent_id });
      },
      close: () => {},
    }),
  }));

  // The pane stays %1 throughout; only the window moves.
  let window = "@1";
  vi.doMock("../src/mux.js", () => ({
    tmux: {
      currentWindow: () => ({
        session: "$0",
        window,
        pane: "%1",
        session_name: null,
        window_name: null,
      }),
      setState: (target: string, state: string | null) => badges.push([target, state]),
    },
  }));

  vi.resetModules();
  const { default: murmurPi } = await import("../src/extension/murmur-pi.js");

  const handlers = new Map<string, () => void | Promise<void>>();
  murmurPi({ on: (event, handler) => handlers.set(event, handler) });
  await handlers.get("agent_start")?.();
  await until(() => appended.length === 1, "first turn's append");

  // The pane is moved to another window between turns.
  window = "@2";
  await handlers.get("agent_start")?.();
  await until(() => appended.length === 2, "second turn's append");

  // The second event records the NEW window, not the startup one.
  expect(appended.map((event) => event.window)).toEqual(["@1", "@2"]);

  // Identity is the pane, so it survives the move: a new agent_id would make
  // the moved agent a second row and orphan the first.
  expect(new Set(appended.map((event) => event.agent_id))).toEqual(new Set(["H:%1"]));

  // The old window's badge is cleared, or a `working` glyph sits forever on a
  // window with no agent. Nothing else can clear it: the badge belongs to the
  // window, and only this process knows the agent left.
  expect(badges).toContainEqual(["@1", null]);
  expect(badges.at(-1)).toEqual(["@2", "working"]);

  vi.doUnmock("@martintrojer/murmur/extension-store");
  vi.doUnmock("../src/mux.js");
  vi.resetModules();
});
