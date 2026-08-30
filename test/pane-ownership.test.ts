import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createIdentity } from "../src/identity.js";
import { openStore } from "../src/store.js";
import { builtArtifact } from "./helpers/built.js";

/**
 * The nested-agent case, reproduced with REAL processes in a REAL tmux pane.
 *
 * Every other extension test fakes the mux and the store, which is right for
 * decision logic and useless here: this bug is entirely about what a separate
 * operating-system process INHERITS. $TMUX_PANE is inherited, so a pi launched
 * inside an agent pane resolves the parent's pane; the owner's claim is
 * inherited, so it can tell that it did. The inheritance is the mechanism, and
 * a mock replaces exactly the thing under test.
 *
 * Observed damage, on the author's own pane %244: six distinct pids reporting
 * for one pane, one alive, and the agent reading as idle while it was working.
 *
 * The defence is `agents.pane UNIQUE` plus one liveness probe inside
 * `claimAgent`'s transaction. A second live process in one pane is REFUSED by
 * the database, which needs no environment transport and so cannot be defeated
 * by a process launched in an unusual way.
 */

// A private tmux server, so nothing here touches the developer's session.
// Same rig as mux-targets.test.ts: -L for tmux's own socket dir, pid-suffixed
// against concurrent runs, -f /dev/null so no personal config is sourced.
const SOCKET = `murmur-ownership-${process.pid}`;
const TMUX = ["-L", SOCKET, "-f", "/dev/null"];
const AGENT = join(process.cwd(), "test", "helpers", "pane-agent.mjs");

/**
 * The built extension and store, resolved through `builtArtifact`.
 *
 * These tests run the real extension in real child processes, so they execute
 * `dist/` and inherit the hazard that helper exists for: a stale build passes
 * while testing code you did not write. Here that would be actively
 * misleading, because the thing under test is a GUARD -- a stale artifact
 * without it would report "nested process wrote nothing" for the wrong reason.
 * Resolved once, at module load, so the check runs before any tmux rig is set up.
 */
const EXTENSION_ENTRY = builtArtifact("extension", "murmur-pi.js");
const STORE_MODULE = builtArtifact("extension", "store.js");

let stateDir: string;

function rig(...args: string[]): string {
  return execFileSync("tmux", [...TMUX, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Run the extension in a child process that believes it is in `pane`.
 *
 * `inherit` is the owner's claim, passed only when simulating a nested launch;
 * a real nested pi gets it from the environment for free, which is precisely
 * what this reproduces.
 */
function runInPane(
  pane: string,
  options: { state?: string; holdMs?: number; spawnChild?: boolean } = {},
): { output: string; pid: number } {
  const out = execFileSync(
    process.execPath,
    [
      AGENT,
      options.state ?? "working",
      String(options.holdMs ?? 0),
      options.spawnChild ? "spawn" : "",
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        MURMUR_STATE_DIR: stateDir,
        // Deliberately NOT set, so the extension resolves its store the way a
        // real install does rather than through the test's own pin.
        MURMUR_STORE_MODULE: STORE_MODULE,
        MURMUR_EXTENSION_ENTRY: EXTENSION_ENTRY,
        TMUX_PANE: pane,
        TMUX: rig("display-message", "-p", "#{socket_path},#{pid},0"),
      },
    },
  );
  const pid = Number(out.match(/RAN (\d+)/)?.[1] ?? 0);
  return { output: out.trim(), pid };
}

/**
 * The pane's agent row, as the store holds it -- or null.
 *
 * This is the honest witness. A child process cannot report whether it won the
 * pane, because `owner_pid` is local-only and absent from every read shape, so
 * there is nothing for it to compare against its own pid. What CAN be checked is
 * that exactly one agent row exists and that its identity did not change.
 */
function agentFor(pane: string): { agent_id: string; activity: string } | null {
  const store = openStore();
  try {
    const found = store.localPanes().find((entry) => entry.pane === pane)?.agent;
    return found ? { agent_id: found.agent_id, activity: found.activity } : null;
  } finally {
    store.close();
  }
}

/** Every attention kind on the pane, so a nested write would be visible. */
function attentionFor(pane: string): string[] {
  const store = openStore();
  try {
    return (
      store
        .localPanes()
        .find((entry) => entry.pane === pane)
        ?.attention.map((a) => a.kind) ?? []
    );
  } finally {
    store.close();
  }
}

beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), "murmur-ownership-"));
  process.env.MURMUR_STATE_DIR = stateDir;
  createIdentity("ownership-rig");
  rig("new-session", "-d", "-s", "own", "sleep 600");
});

afterAll(() => {
  let socketPath: string | null = null;
  try {
    socketPath = rig("display-message", "-p", "#{socket_path}");
  } catch {
    // Server already gone.
  }
  try {
    rig("kill-server");
  } catch {
    // Already gone, or never started.
  }
  if (socketPath) rmSync(socketPath, { force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

test("a real nested process in an agent's pane records nothing at all", async () => {
  const pane = rig("display-message", "-p", "#{pane_id}");

  // The owner: first process in the pane, so its claim is accepted and it
  // reports. It has already EXITED by the time execFileSync returns, which
  // matters for the next line.
  const owner = runInPane(pane);
  expect(owner.output).toContain("RAN");
  const claimed = agentFor(pane);
  expect(claimed).toMatchObject({ activity: "running" });

  // A second process in the same pane while the first is gone: this is a
  // legitimate restart, and it must take over rather than be frozen out. The
  // liveness probe is what makes that work with no grace period to tune.
  const restart = runInPane(pane);
  expect(restart.pid).not.toBe(owner.pid);
  const afterRestart = agentFor(pane);
  // A different ROW, because a replacement owner is a different process
  // instance: the agent_id is a per-process uuid, not `host:pane`, so a late
  // write from the previous owner cannot match it.
  expect(afterRestart?.agent_id).not.toBe(claimed?.agent_id);
  expect(afterRestart?.activity).toBe("running");
});

test("a live owner is not displaced, and the nested process writes nothing", async () => {
  // The six-pid bug, with the marker gone. The competitor inherits $TMUX_PANE --
  // that is unavoidable and is the mechanism -- but nothing tells it the pane is
  // owned. Only the store can refuse it, and it must, because two live processes
  // cannot both be the agent in one pane.
  const pane = rig("new-window", "-P", "-F", "#{pane_id}", "-d", "sleep 600");

  // An owner that stays ALIVE while the competitors run, so the liveness probe
  // inside claimAgent answers true -- the condition the real bug violated.
  const holder = spawn(process.execPath, [AGENT, "working", "12000"], {
    env: {
      ...process.env,
      MURMUR_STATE_DIR: stateDir,
      MURMUR_STORE_MODULE: STORE_MODULE,
      MURMUR_EXTENSION_ENTRY: EXTENSION_ENTRY,
      TMUX_PANE: pane,
      TMUX: rig("display-message", "-p", "#{socket_path},#{pid},0"),
    },
    stdio: ["ignore", "pipe", "ignore"],
  });

  let held = "";
  holder.stdout.on("data", (chunk) => {
    held += chunk;
  });
  for (let wait = 0; wait < 200 && !held.includes("RAN"); wait += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(held).toContain("RAN");
  const owned = agentFor(pane);
  expect(owned).toMatchObject({ activity: "running" });

  try {
    // Five nested launches, matching the five extra pids seen on the real pane.
    for (let launch = 0; launch < 5; launch += 1) {
      runInPane(pane);
    }

    // The owner's row survives byte-for-byte. On the real pane this was six
    // reporting pids and an agent that read as idle while it was working.
    expect(agentFor(pane)).toEqual(owned);

    // And a nested agent_end -- which erased the agent from every surface on the
    // real pane -- writes nothing either.
    runInPane(pane, { state: "end" });
    expect(agentFor(pane)).toEqual(owned);
    expect(attentionFor(pane)).toEqual([]);
  } finally {
    holder.kill("SIGKILL");
  }
});

test("an owner's real child process is refused with nothing passed to it", async () => {
  // An owner's own child, with no environment arrangement of any kind: the child
  // gets the default environment and no arguments about ownership, and is still
  // refused, because the refusal comes from the database and the owner is alive.
  const pane = rig("new-window", "-P", "-F", "#{pane_id}", "-d", "sleep 600");

  const owner = runInPane(pane, { spawnChild: true, holdMs: 3_000 });
  expect(owner.output).toContain("RAN");
  expect(owner.output).toContain("CHILD RAN");

  // One row, and it is the one the owner claimed while it was alive: the child
  // ran INSIDE the owner's lifetime, so the probe saw a live pid and refused.
  const after = agentFor(pane);
  expect(after).toMatchObject({ activity: "running" });
});
