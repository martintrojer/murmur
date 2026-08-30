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

function linkPi(home: string, ...args: string[]): string {
  return execFileSync(
    process.execPath,
    [join(process.cwd(), "dist", "cli.js"), "link", "pi", ...args],
    { env: { ...process.env, MURMUR_PI_HOME: home }, encoding: "utf8" },
  );
}

/** As above, but with a state dir of its own, so identity presence is controlled. */
function linkPiWithState(home: string, stateDir: string, ...args: string[]): string {
  return execFileSync(
    process.execPath,
    [join(process.cwd(), "dist", "cli.js"), "link", "pi", ...args],
    {
      env: { ...process.env, MURMUR_PI_HOME: home, MURMUR_STATE_DIR: stateDir },
      encoding: "utf8",
    },
  );
}

function installedExtension(home: string): string {
  return readFileSync(join(home, ".pi", "agent", "extensions", "murmur.ts"), "utf8");
}

test("link pi re-exports the install rather than copying it, so upgrades apply", () => {
  // The upgrade story. `link pi` used to inline the whole built extension, which
  // made the installed file a point-in-time snapshot: upgrading murmur left the
  // OLD extension running with no warning. The author's own machine was running
  // an extension missing two committed fixes -- a silently wrong state report,
  // which is the exact failure the extension exists to prevent.
  const home = mkdtempSync(join(tmpdir(), "murmur-link-"));
  linkPi(home);
  const source = installedExtension(home);

  // Points at the install; does not contain the extension's own logic.
  expect(source).not.toContain("agent_start");
  const entry = source.match(/await import\("([^"]+)"\)/)?.[1] ?? "";
  expect(entry.startsWith("/")).toBe(true);
  expect(existsSync(entry)).toBe(true);
});

test("the shim pins the store path, which the extension cannot resolve itself", () => {
  // A bare "@martintrojer/murmur/extension-store" specifier cannot resolve from
  // ~/.pi/agent/extensions -- not even for a global install. The failure is
  // silent: the import throws, getStore swallows it, and every append no-ops
  // while the tmux badge still paints. Verified against a real pi: with the
  // path unpinned the store module never loaded.
  const home = mkdtempSync(join(tmpdir(), "murmur-link-"));
  linkPi(home);
  const source = installedExtension(home);

  const storePath = source.match(/MURMUR_STORE_MODULE \?\?= "([^"]+)"/)?.[1] ?? "";
  expect(storePath.startsWith("/")).toBe(true);
  expect(existsSync(storePath)).toBe(true);

  // Set BEFORE the import, and via a dynamic import: ESM hoists static
  // re-exports above the assignment, so `export ... from` left the extension
  // reading undefined. Verified directly -- the static form printed undefined.
  expect(source.indexOf("MURMUR_STORE_MODULE")).toBeLessThan(source.indexOf("await import"));
  expect(source).not.toMatch(/export \{ default \} from/);
});

test("--copy still inlines and pins, for an install that must stand alone", () => {
  const home = mkdtempSync(join(tmpdir(), "murmur-link-"));
  linkPi(home, "--copy");
  const source = installedExtension(home);

  // The real thing, with the specifier rewritten in place.
  expect(source).toContain("agent_start");
  const pinned =
    source.match(/storeModule =\s*process\.env\.MURMUR_STORE_MODULE \|\| "([^"]+)"/)?.[1] ?? "";
  expect(pinned.startsWith("/")).toBe(true);
  expect(existsSync(pinned)).toBe(true);
});

test("re-linking reports an inlined copy it replaced, and stays quiet otherwise", () => {
  // Anyone linked before the shim existed has a snapshot that stopped tracking
  // upgrades silently, and "wrote a file" does not tell them their agents may
  // have been misreporting.
  const home = mkdtempSync(join(tmpdir(), "murmur-link-"));

  expect(linkPi(home)).not.toContain("Replaced an inlined copy");
  // Re-linking a shim must not claim it replaced a copy. This regressed once:
  // the check keyed on the import statement, which changed when the hoisting
  // bug above was fixed.
  expect(linkPi(home)).not.toContain("Replaced an inlined copy");

  linkPi(home, "--copy");
  expect(linkPi(home)).toContain("Replaced an inlined copy");
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
      setWindowBadge: () => {},
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
      setWindowBadge: () => {},
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
      setWindowBadge: () => {},
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
      setWindowBadge: (target: string, state: string | null) => badges.push([target, state]),
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

test("link warns when the node has no identity, since the extension would record nothing", () => {
  // Found while testing the shim against a real pi: events fired, handlers ran,
  // and nothing was written. The extension reads identity with loadIdentity and
  // returns early when it is absent -- deliberately, because an agent must not
  // decide what this node is called -- but the consequence is invisible. The
  // badge still paints, so the agent looks fine while the log stays empty.
  //
  // Linking is the only moment a human is looking at this path, so it is where
  // the warning belongs.
  const home = mkdtempSync(join(tmpdir(), "murmur-link-"));
  const stateDir = mkdtempSync(join(tmpdir(), "murmur-noident-"));

  expect(linkPiWithState(home, stateDir)).toContain("murmur init");

  // And is silent once the node has one.
  execFileSync(process.execPath, [join(process.cwd(), "dist", "cli.js"), "init"], {
    env: { ...process.env, MURMUR_STATE_DIR: stateDir },
    stdio: "ignore",
  });
  expect(linkPiWithState(home, stateDir)).not.toContain("murmur init");
});

test("session_shutdown does not permanently silence the extension, because /reload fires it", async () => {
  // Observed live: reporting stopped the instant `/reload` ran and never came
  // back. `session_shutdown` reads like "the process is exiting", and the
  // handler marked the extension absent on that assumption -- but pi fires it
  // for /reload, and for session switch, resume and fork, then keeps using the
  // same extension instance. Every later event was dropped while the tmux badge
  // still painted, so the agent looked fine and reported nothing.
  const appended: string[] = [];

  vi.doMock("@martintrojer/murmur/extension-store", () => ({
    loadIdentity: () => ({ host_id: "H", display_name: "h" }),
    openStore: () => ({
      append: (event: { state: string }) => appended.push(event.state),
      close: () => {},
    }),
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
      setWindowBadge: () => {},
    },
  }));

  vi.resetModules();
  const { default: murmurPi } = await import("../src/extension/murmur-pi.js");

  const handlers = new Map<string, () => void | Promise<void>>();
  murmurPi({ on: (event, handler) => handlers.set(event, handler) });

  // The full documented cycle: pi fires session_shutdown for the old instance,
  // rebinds, then fires session_start. Extensions clean up in the first and
  // reestablish in the second.
  await handlers.get("agent_start")?.();
  await until(() => appended.length === 1, "first turn");
  await handlers.get("session_shutdown")?.();
  await until(() => appended.length === 2, "reload's own clear");
  await handlers.get("session_start")?.();
  await handlers.get("agent_start")?.();
  await until(() => appended.length === 3, "turn after reload");

  // The turn after the reload must be recorded. Before the fix this was
  // ["working", "cleared"] -- the reload's own clear, and then silence.
  expect(appended).toEqual(["working", "cleared", "working"]);

  // And it must keep working across repeated reloads, not just the first.
  await handlers.get("session_shutdown")?.();
  await handlers.get("session_start")?.();
  await handlers.get("agent_start")?.();
  await until(() => appended.length === 5, "turn after a second reload");
  expect(appended).toEqual(["working", "cleared", "working", "cleared", "working"]);

  vi.doUnmock("@martintrojer/murmur/extension-store");
  vi.doUnmock("../src/mux.js");
  vi.resetModules();
});

test("session_start re-arms an extension that gave up, so a reload is a real recovery", async () => {
  // The other half of handling /reload. `absent` is the extension's permanent
  // "stop trying" -- set when the store import fails or the node has no
  // identity. Both are fixable from outside while pi is running: install
  // murmur, or run `murmur init`. Without re-arming, the fix would not take
  // effect until the agent was restarted, and /reload would look like it did
  // nothing.
  let identity: { host_id: string } | null = null;
  const appended: string[] = [];

  vi.doMock("@martintrojer/murmur/extension-store", () => ({
    loadIdentity: () => identity,
    openStore: () => ({
      append: (event: { state: string }) => appended.push(event.state),
      close: () => {},
    }),
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
      setWindowBadge: () => {},
    },
  }));

  vi.resetModules();
  const { default: murmurPi } = await import("../src/extension/murmur-pi.js");

  const handlers = new Map<string, () => void | Promise<void>>();
  murmurPi({ on: (event, handler) => handlers.set(event, handler) });

  // No identity: the extension gives up permanently, by design.
  await handlers.get("agent_start")?.();
  await until(() => appended.length > 0, "an append that should not happen");
  expect(appended).toEqual([]);

  // The user runs `murmur init` and reloads.
  //
  // session_start alone, WITHOUT session_shutdown first. dropStore also returns
  // the state to "untried", so driving the full shutdown/start pair would pass
  // even with no re-arm at all -- the test would be asserting the wrong
  // mechanism. Confirmed by mutation: with the pair, removing the re-arm still
  // passed.
  identity = { host_id: "H" };
  await handlers.get("session_start")?.();
  await handlers.get("agent_start")?.();
  await until(() => appended.includes("working"), "append after init + reload");

  expect(appended).toContain("working");

  vi.doUnmock("@martintrojer/murmur/extension-store");
  vi.doUnmock("../src/mux.js");
  vi.resetModules();
});
