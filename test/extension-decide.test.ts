import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
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
