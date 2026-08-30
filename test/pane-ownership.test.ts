import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ensureIdentity } from "../src/identity.js";
import { openStore } from "../src/store.js";
import { builtArtifact } from "./helpers/built.js";

/**
 * The six-pid bug, reproduced with REAL processes in a REAL tmux pane.
 *
 * Every other extension test fakes the mux and the store, which is right for
 * decision logic and useless here: this bug is entirely about what a separate
 * operating-system process INHERITS. $TMUX_PANE is inherited, so a pi launched
 * inside an agent pane resolves the parent's pane; the owner's claim is
 * inherited, so it can tell that it did. The inheritance is the mechanism, and
 * a mock replaces exactly the thing under test.
 *
 * Observed damage, on the author's own pane %244: six distinct pids had written
 * `working`, one alive. The parent's row folded off a dead child's pid and the
 * agent showed as idle while it was working, plus five doubled `cleared` pairs
 * 0-1s apart -- two processes each correctly firing once.
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
  options: { state?: string; inherit?: string; holdMs?: number; spawnChild?: boolean } = {},
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
        ...(options.inherit ? { MURMUR_PANE_OWNER: options.inherit } : {}),
      },
    },
  );
  const pid = Number(out.match(/REPORTED (\d+)/)?.[1] ?? 0);
  return { output: out.trim(), pid };
}

/** Every pid that has ever written a `working` row for this pane. */
function reportingPids(pane: string): number[] {
  const store = openStore();
  try {
    const identity = ensureIdentity();
    return store
      .allEvents()
      .filter((event) => event.agent_id === `${identity.host_id}:${pane}` && event.pid !== null)
      .map((event) => event.pid as number);
  } finally {
    store.close();
  }
}

function statesFor(pane: string): string[] {
  const store = openStore();
  try {
    const identity = ensureIdentity();
    return store
      .allEvents()
      .filter((event) => event.agent_id === `${identity.host_id}:${pane}`)
      .map((event) => event.state);
  } finally {
    store.close();
  }
}

beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), "murmur-ownership-"));
  process.env.MURMUR_STATE_DIR = stateDir;
  ensureIdentity();
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

  // The owner: first process in the pane, so it claims it and reports.
  const owner = runInPane(pane);
  expect(owner.output).toContain("REPORTED");
  expect(reportingPids(pane)).toEqual([owner.pid]);

  // A nested launch, inheriting the owner's claim exactly as a child pi would.
  // This is the case that wrote five extra `working` rows to a live agent.
  const nested = runInPane(pane, { inherit: `${pane}:${owner.pid}` });

  // Silence, not a corrected write. It registered no handlers at all, so no
  // store was opened and no badge painted: a process with nothing true to say
  // says nothing.
  expect(nested.output).toBe("DECLINED");

  // The parent row SURVIVES, which is the whole point. Before the fix this was
  // two pids and the agent read as idle.
  expect(reportingPids(pane)).toEqual([owner.pid]);
  expect(statesFor(pane)).toEqual(["working"]);
});

test("many nested launches leave exactly one reporting pid, not six", async () => {
  const pane = rig("new-window", "-P", "-F", "#{pane_id}", "-d", "sleep 600");

  const owner = runInPane(pane);
  // Five nested launches, matching the five extra pids seen on the real pane.
  for (let launch = 0; launch < 5; launch += 1) {
    expect(runInPane(pane, { inherit: `${pane}:${owner.pid}` }).output).toBe("DECLINED");
  }

  // The measured symptom was SIX distinct pids on one pane. One is correct.
  expect(new Set(reportingPids(pane)).size).toBe(1);
  expect(reportingPids(pane)).toEqual([owner.pid]);
});

test("a nested process cannot write the doubled cleared the real bug produced", async () => {
  const pane = rig("new-window", "-P", "-F", "#{pane_id}", "-d", "sleep 600");

  runInPane(pane);
  // agent_end, from a nested process. On the real pane this produced five
  // `cleared` pairs 0-1s apart: not a double fire, two processes each firing
  // once. A doubled clear is worse than a doubled working -- `cleared` resets
  // the row to idle and drops the event, so it erases the agent from every HUD.
  expect(runInPane(pane, { state: "end", inherit: `${pane}:9999999` }).output).toBe("DECLINED");

  expect(statesFor(pane)).toEqual(["working"]);
});

test("an owner's real child process discovers it is nested with nothing passed to it", async () => {
  // The publishing half, and a mutation found this gap: deleting the line that
  // exports the claim left every other test in this file passing, because they
  // all handed the claim to the child themselves. That tested the READING side
  // twice and the WRITING side never.
  //
  // Here the owner spawns the child itself. The child gets the default
  // environment and no arguments about ownership, so the ONLY way it can know
  // it is nested is that the owner published a claim -- which is precisely the
  // mechanism a real nested pi relies on.
  const pane = rig("new-window", "-P", "-F", "#{pane_id}", "-d", "sleep 600");

  const owner = runInPane(pane, { spawnChild: true });
  expect(owner.output).toContain("REPORTED");
  expect(owner.output).toContain("CHILD DECLINED");

  // One pid, and it is the owner's.
  expect(reportingPids(pane)).toEqual([owner.pid]);
});

test("a live recorded pid is not superseded even without the claim", async () => {
  // The floor, tested with the marker ABSENT -- which is the case the marker
  // cannot cover: a pi that predates this change, or one launched in a way that
  // dropped the environment. The competing process is a genuine second writer
  // with no idea the pane is owned.
  const pane = rig("new-window", "-P", "-F", "#{pane_id}", "-d", "sleep 600");

  // An owner that stays ALIVE while the competitor runs, so `pidAlive` on its
  // recorded pid answers true -- the condition the real bug violated.
  const holder = spawn(process.execPath, [AGENT, "working", "8000"], {
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
  for (let wait = 0; wait < 200 && !held.includes("REPORTED"); wait += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const holderPid = Number(held.match(/REPORTED (\d+)/)?.[1] ?? 0);
  expect(holderPid).toBeGreaterThan(0);

  try {
    // No inherited claim, so ownsPane lets this through and only the live-pid
    // floor can stop it. It registers handlers and tries to append.
    const competitor = runInPane(pane);
    expect(competitor.output).toContain("REPORTED");

    // ...and is refused at the store, because the recorded pid is still alive.
    // Two live processes cannot both be the agent in one pane.
    expect(reportingPids(pane)).toEqual([holderPid]);
  } finally {
    holder.kill("SIGKILL");
  }
});

test("a genuine restart in the same pane takes over once the old agent is gone", async () => {
  // Pane %89 has two pids for good reason, and the fix must not freeze a stale
  // row. This is the case that makes the floor a liveness question rather than
  // a difference question.
  const pane = rig("new-window", "-P", "-F", "#{pane_id}", "-d", "sleep 600");

  const first = runInPane(pane);
  expect(first.output).toContain("REPORTED");
  // The first process has already EXITED -- execFileSync is synchronous -- so
  // its recorded pid is dead, exactly like an agent that finished.
  expect(reportingPids(pane)).toEqual([first.pid]);

  // A new agent starts in the same pane. No claim: a restart is a fresh
  // process tree, so nothing is inherited.
  const second = runInPane(pane);
  expect(second.output).toContain("REPORTED");
  expect(second.pid).not.toBe(first.pid);

  // Both rows are present and the NEW pid is the current one. No grace period
  // and no staleness horizon: the old pid is gone, so the new one takes over.
  expect(reportingPids(pane)).toEqual([first.pid, second.pid]);
  expect(reportingPids(pane).at(-1)).toBe(second.pid);
});

test("a pid-less cleared row does not retract the live agent's claim", async () => {
  // The shape of the REAL damage, and the case a naive "read the newest row"
  // floor fails open on. Measured from the live database, pane %244:
  //
  //   working(61980) working(80183) cleared(null) cleared(null)
  //   working(82862) cleared(null) cleared(null) working(87286) ...
  //
  // Only `working` carries a pid; done, blocked and cleared are null by design.
  // So after the very first turn ended, the newest row was always a pid-less
  // `cleared` and every later nested launch was waved through. Confirmed by
  // running the extension against a COPY of the real database: with the newest
  // row a `cleared`, a fresh write was accepted.
  const pane = rig("new-window", "-P", "-F", "#{pane_id}", "-d", "sleep 600");

  // An owner that stays alive, and a `cleared` row on top of its `working`.
  const holder = spawn(process.execPath, [AGENT, "working", "8000", ""], {
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
  for (let wait = 0; wait < 200 && !held.includes("REPORTED"); wait += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const holderPid = Number(held.match(/REPORTED (\d+)/)?.[1] ?? 0);
  expect(holderPid).toBeGreaterThan(0);

  try {
    // The owner's own turn ends: a pid-less `cleared` becomes the newest row.
    const store = openStore();
    const identity = ensureIdentity();
    const latest = store.latestForAgent(identity.host_id, `${identity.host_id}:${pane}`);
    if (!latest) throw new Error("owner wrote nothing");
    store.append({ ...latest, state: "cleared", pid: null });
    store.close();

    // A competing writer with no claim, exactly as before -- but now the newest
    // row carries no pid. The floor must still refuse it, because the last PID
    // is still the live owner's and a pid-less row does not retract it.
    const competitor = runInPane(pane);
    expect(competitor.output).toContain("REPORTED");

    expect(reportingPids(pane)).toEqual([holderPid]);
  } finally {
    holder.kill("SIGKILL");
  }
});
