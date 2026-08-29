import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { driverFromEnv, endState } from "../src/extension/decide.js";

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
