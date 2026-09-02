import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { Channel } from "../src/channel.js";
import {
  COLLECT_FLOOR_MS,
  COLLECT_JITTER_MS,
  collect,
  describeFailure,
  MAX_CONCURRENT_PEERS,
  needsInteractiveAuth,
} from "../src/collector.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { openStore, type Store } from "../src/store.js";
import type { Snapshot, SnapshotPane } from "../src/types.js";
import { STALENESS_MS } from "../src/view.js";

const stores: Store[] = [];
let store: Store;

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-collector-"));
  store = openStore();
  stores.push(store);
});

afterEach(() => {
  for (const opened of stores.splice(0)) opened.close();
});

function pane(id: string): SnapshotPane {
  return {
    pane: asPaneId(id),
    session: asSessionId("$0"),
    window: asWindowId("@0"),
    session_name: null,
    window_name: null,
    agent: {
      agent_id: `agent-${id}`,
      activity: "running",
      agent_name: null,
      pi_session: null,
      workstream: null,
      role: null,
      cli: "pi",
      driver: "human",
      claimed_at: 1,
      updated_at: 1,
    },
    attention: [],
  };
}

function snapshot(panes: SnapshotPane[], hostId = "REMOTE", over: Partial<Snapshot> = {}): string {
  return JSON.stringify({
    murmur_snapshot: 1,
    host_id: hostId,
    display_name: "Remote",
    murmur_version: "0.2.0",
    generated_at: 1_000,
    panes,
    ...over,
  });
}

test("collect replaces a peer's cached snapshot whole", async () => {
  store.addPeer("dev", "dev.example");
  const channel: Channel = {
    exec: async (target, argv) => {
      expect(target).toBe("dev.example");
      // Bare `murmur export`, which takes no options: the document is complete,
      // so there is nothing to ask for and no second round trip.
      expect(argv).toEqual(["murmur", "export"]);
      return snapshot([pane("%1"), pane("%2")]);
    },
  };

  await expect(collect(store, channel, 5_000)).resolves.toEqual([
    { peer: "dev", ok: true, panes: 2 },
  ]);
  expect(store.peers()[0]).toMatchObject({
    name: "dev",
    host_id: "REMOTE",
    display_name: "Remote",
    murmur_version: "0.2.0",
    snapshot_version: 1,
    snapshot_at: 1_000,
    fetched_at: 5_000,
    last_error: null,
  });
  expect(store.peers()[0]?.snapshot?.panes.map((entry) => entry.pane)).toEqual(["%1", "%2"]);
});

test("a pane present before and absent after is gone from the cache", async () => {
  // The property that makes incremental sync unnecessary: a successful fetch is
  // the whole truth about that node, so absence in it means absence. No
  // tombstone has to be transmitted for a pane to disappear everywhere.
  store.addPeer("dev", "dev");
  await collect(store, { exec: async () => snapshot([pane("%1"), pane("%2")]) }, 1_000);

  await collect(store, { exec: async () => snapshot([pane("%2")]) }, 2_000);

  expect(store.peers()[0]?.snapshot?.panes.map((entry) => entry.pane)).toEqual(["%2"]);
});

test("a failed fetch keeps the last snapshot and leaves fetched_at alone", async () => {
  store.addPeer("dev", "dev");
  await collect(store, { exec: async () => snapshot([pane("%1")]) }, 1_000);

  const results = await collect(
    store,
    {
      exec: async () => {
        throw new Error("ssh: connect to host dev port 22: Host is down");
      },
    },
    9_000,
  );

  expect(results[0]).toMatchObject({ peer: "dev", ok: false, unreachable: true });
  const peer = store.peers()[0];
  // The last-known snapshot stands, and the peer ages into `stale` on its own
  // rather than being emptied by one unreachable tick.
  expect(peer?.snapshot?.panes).toHaveLength(1);
  expect(peer).toMatchObject({ fetched_at: 1_000, last_attempt_at: 9_000 });
  expect(peer?.last_error).toContain("Host is down");
});

test("an invalid snapshot is rejected before storage and reads as reachable-but-broken", async () => {
  // Each of these is a document a node could plausibly serve: a newer protocol,
  // a state this version does not know, a pane emitted twice, a field added or
  // dropped. None may reach storage, because a half-valid document is how an
  // unknown value gets into a sort, a count or a render path.
  const documents: [name: string, body: string][] = [
    ["a newer protocol", snapshot([pane("%1")], "REMOTE", { murmur_snapshot: 2 } as never)],
    [
      "an unknown activity",
      JSON.stringify(JSON.parse(snapshot([pane("%1")])), (key, value) =>
        key === "activity" ? "working" : value,
      ),
    ],
    ["a duplicate pane", snapshot([pane("%1"), pane("%1")])],
    ["an unknown top-level key", snapshot([pane("%1")], "REMOTE", { extra: "x" } as never)],
    ["a missing key", '{"murmur_snapshot":1,"host_id":"H","panes":[]}'],
    ["not JSON at all", "murmur: command not found"],
    ["an empty pane entry", snapshot([{ ...pane("%1"), agent: null, attention: [] }])],
  ];

  for (const [name, body] of documents) {
    process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-invalid-"));
    const fresh = openStore();
    stores.push(fresh);
    fresh.addPeer("dev", "dev");

    const results = await collect(fresh, { exec: async () => body }, 5_000);

    expect(results[0]?.ok, name).toBe(false);
    // Reachable but BROKEN, never "asleep, probably": an operator has to be able
    // to tell a bad pairing from a sleeping laptop.
    expect(results[0]?.unreachable, name).toBe(false);
    expect(fresh.peers()[0]?.snapshot, name).toBeNull();
    expect(fresh.peers()[0]?.last_error, name).toBeTruthy();
  }
});

test("a permission failure is reachable-but-broken, not unreachable", async () => {
  // An auth misconfiguration is an operator task, and classing it as
  // unreachable is how a fixable setup error stays invisible for weeks: the
  // unreachable path is deliberately quiet, because a fleet always has
  // sleeping nodes.
  store.addPeer("dev", "dev");

  const results = await collect(
    store,
    {
      exec: async () => {
        throw new Error("dev: Permission denied (publickey).");
      },
    },
    5_000,
  );

  expect(results[0]).toMatchObject({ ok: false, unreachable: false });
});

test("peers are fetched concurrently, so a slow peer does not hold up the rest", async () => {
  // The regression this guards: a serial loop charged every peer the full ssh
  // timeout of the peer ahead of it, so three asleep laptops froze the HUD.
  for (const name of ["a", "b", "c"]) store.addPeer(name, name);
  let inFlight = 0;
  let peak = 0;
  const channel: Channel = {
    exec: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return snapshot([pane("%1")]);
    },
  };

  const results = await collect(store, channel, 5_000);

  expect(peak).toBe(3);
  expect(results.map((item) => item.peer)).toEqual(["a", "b", "c"]);
});

test("fan-out is capped, and every peer still gets collected in order", async () => {
  // The roof matters because each in-flight peer is its own forked ssh client
  // process, and a cold one holds that process for the full connect timeout. A
  // long peer list must not put all of them resident at once.
  const names = Array.from({ length: MAX_CONCURRENT_PEERS * 3 }, (_, i) =>
    String(i).padStart(2, "0"),
  );
  for (const name of names) store.addPeer(name, name);
  let inFlight = 0;
  let peak = 0;
  const channel: Channel = {
    exec: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return snapshot([pane("%1")]);
    },
  };

  const results = await collect(store, channel, 5_000);

  expect(peak).toBe(MAX_CONCURRENT_PEERS);
  expect(results.map((item) => item.peer)).toEqual(names);
  expect(results.every((item) => item.ok)).toBe(true);
});

test("a slow peer occupies one slot, it does not stall the queue behind it", async () => {
  // Guards the shared-cursor worker pool against a naive fixed-batch chunker,
  // where the whole batch waits on its slowest member before the next starts.
  const names = Array.from({ length: MAX_CONCURRENT_PEERS + 2 }, (_, i) => `p${i}`);
  for (const name of names) store.addPeer(name, name);
  let slowDone = false;
  const startedAfterSlowFinished: string[] = [];
  const channel: Channel = {
    exec: async (target) => {
      if (slowDone) startedAfterSlowFinished.push(target);
      await new Promise((resolve) => setTimeout(resolve, target === "p0" ? 60 : 1));
      if (target === "p0") slowDone = true;
      return snapshot([pane("%1")]);
    },
  };

  await collect(store, channel, 5_000);

  expect(startedAfterSlowFinished).toEqual([]);
});

test("a peer that fails late is reported, not an unhandled rejection", async () => {
  store.addPeer("slow", "slow");
  store.addPeer("fast-fail", "fast-fail");
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const channel: Channel = {
    exec: async (target) => {
      if (target === "fast-fail") throw new Error("boom");
      await new Promise((resolve) => setTimeout(resolve, 20));
      return snapshot([pane("%1")]);
    },
  };

  try {
    const results = await collect(store, channel, 5_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(results).toEqual([
      { peer: "fast-fail", ok: false, panes: 0, error: "boom", unreachable: false },
      { peer: "slow", ok: true, panes: 1 },
    ]);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("an empty peer list touches no channel and still reconciles locally", async () => {
  // The single-machine path. `reconcileLocal` is the only housekeeping left and
  // it must run with zero peers, which is why it lives on collect rather than on
  // export: export only runs when a PEER asks over ssh, so a laptop with no
  // peers reconciled never and four dead crew rows sat in the picker
  // indefinitely.
  let calls = 0;
  const spy: Channel = {
    exec: async () => {
      calls += 1;
      return "";
    },
  };

  await expect(collect(store, spy)).resolves.toEqual([]);
  expect(calls).toBe(0);
});

test("collect never writes to stderr, whatever the peer does", async () => {
  // The contract that makes the polling paths usable. `collect` is called by
  // `murmur status` on every tmux status-bar tick and by `pick` inside a
  // display-popup. It used to print two lines of ssh diagnostics per failed peer
  // -- the full invocation plus ssh's own message -- so one sleeping laptop wrote
  // to stderr several times a minute forever, and into a popup.
  store.addPeer("down", "down");
  store.addPeer("broken", "broken");

  const channel: Channel = {
    exec: async (target) => {
      if (target === "down") {
        throw new Error(
          "Command failed: ssh -o BatchMode=yes down murmur export\nssh: connect to host down port 22: Host is down",
        );
      }
      return "not a snapshot";
    },
  };

  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  let results: Awaited<ReturnType<typeof collect>>;
  try {
    results = await collect(store, channel, 5_000);
  } finally {
    process.stderr.write = original;
  }

  expect(written.join("")).toBe("");

  // And the information is not lost: it is in the result, including which KIND
  // of failure it was, so a caller can report a broken peer while staying quiet
  // about a sleeping one.
  const byPeer = new Map(results.map((result) => [result.peer, result]));
  expect(byPeer.get("down")?.unreachable).toBe(true);
  expect(byPeer.get("broken")?.unreachable).toBe(false);
});

test("a peer failure is described in one line a human can act on", () => {
  // The raw error is the whole ssh command line plus ssh's message. The
  // actionable part is the host and the reason; the ssh options are murmur's own
  // and the user cannot do anything about them.
  expect(
    describeFailure(
      "linuxpc",
      "Command failed: ssh -o BatchMode=yes -o ControlPath=~/.ssh/control/%r@%h:%p linuxpc murmur export\nssh: connect to host linuxpc port 22: Host is down",
    ),
  ).toBe("linuxpc: unreachable (Host is down)");

  // A reachable peer that answers wrongly keeps its message, because that IS the
  // diagnosis, but bounded so a corrupt document cannot print a screenful.
  expect(describeFailure("dev", "panes[3].attention[0].kind: expected one of done")).toBe(
    "dev: panes[3].attention[0].kind: expected one of done",
  );
  expect(describeFailure("dev", "x".repeat(400)).length).toBeLessThan(200);

  // Unreachable is classified by what ssh says, not by guessing. Each of these
  // is a real ssh failure mode from a fleet with sleeping nodes.
  for (const message of [
    "ssh: connect to host box port 22: No route to host",
    "ssh: connect to host box port 22: Connection refused",
    "ssh: connect to host box port 22: Operation timed out",
    "ssh: Could not resolve hostname box: nodename nor servname provided",
  ]) {
    expect(describeFailure("box", message)).toContain("unreachable");
  }

  // And an auth failure is NOT unreachable: it is a setup problem an operator
  // can fix, and the quiet path is for hosts that are merely asleep.
  expect(describeFailure("box", "box: Permission denied (publickey).")).not.toContain(
    "unreachable",
  );
});

// --- the collect floor ----------------------------------------------------
//
// Collection is driven by tmux re-running `murmur status` on a tick, and every
// run used to fetch every peer. That ties fetch rate to REDRAW rate, and it is
// quadratic in a mesh: N nodes each fetching N-1 peers is N*(N-1) forked ssh
// processes per tick, fleet-wide, multiplied again by attached tmux clients.

/**
 * Jitter pinned to the middle of the window, i.e. no offset at all.
 *
 * The floor tests below are about the FLOOR, so they must not also depend on a
 * draw: `random` is injected for exactly this, the way `now` already is.
 */
const centre = () => 0.5;

/** Counts execs so a test can assert an ssh did NOT happen. */
function counting(body: () => string): { channel: Channel; calls: () => number } {
  let calls = 0;
  return {
    channel: {
      exec: async () => {
        calls += 1;
        return body();
      },
    },
    calls: () => calls,
  };
}

test("a peer attempted inside the floor is not fetched again", async () => {
  store.addPeer("dev", "dev.example");
  const { channel, calls } = counting(() => snapshot([pane("%1")]));

  await collect(store, channel, 1_000, { floorMs: 30_000, random: centre });
  expect(calls()).toBe(1);

  // Ten seconds later, which is two status-bar ticks at the author's interval
  // and would have been two more ssh processes.
  const results = await collect(store, channel, 11_000, { floorMs: 30_000, random: centre });
  expect(calls()).toBe(1);
  // Omitted entirely rather than reported: a skip is not an outcome ABOUT the
  // peer, and `murmur collect` -- the only surface that prints results -- never
  // passes a floor, so no reader has to learn a third state.
  expect(results).toEqual([]);
  // And the cached document is untouched, so the reader still sees the peer.
  expect(store.peers()[0]?.snapshot?.panes).toHaveLength(1);
});

test("a peer past the floor is fetched", async () => {
  store.addPeer("dev", "dev.example");
  const { channel, calls } = counting(() => snapshot([pane("%1")]));

  await collect(store, channel, 1_000, { floorMs: 30_000, random: centre });
  await collect(store, channel, 31_000, { floorMs: 30_000, random: centre });
  expect(calls()).toBe(2);
});

test("the floor is keyed on the attempt, so an unreachable peer is throttled too", async () => {
  // The expensive case, and the reason this keys on `last_attempt_at` rather
  // than `fetched_at`: a sleeping laptop costs a forked ssh that sits until
  // ConnectTimeout. Keying on the successful fetch would exempt exactly the
  // peers the floor exists to stop hammering, since they never fetch.
  store.addPeer("asleep", "asleep.example");
  let calls = 0;
  const dead: Channel = {
    exec: async () => {
      calls += 1;
      throw new Error("ssh: connect to host asleep.example port 22: Operation timed out");
    },
  };

  const first = await collect(store, dead, 1_000, { floorMs: 30_000, random: centre });
  expect(first[0]).toMatchObject({ ok: false, unreachable: true });
  expect(calls).toBe(1);

  await collect(store, dead, 11_000, { floorMs: 30_000, random: centre });
  expect(calls).toBe(1);
});

test("a peer that has never been attempted is always due", async () => {
  // A freshly added peer must appear without waiting out a floor, so `peer add`
  // followed by a status tick shows it.
  store.addPeer("dev", "dev.example");
  const { channel, calls } = counting(() => snapshot([pane("%1")]));

  await collect(store, channel, 500_000, { floorMs: 30_000, random: centre });
  expect(calls()).toBe(1);
});

test("no floor means every peer is fetched, however recently attempted", async () => {
  // The default, and what `murmur collect` and the picker both get. A person
  // pressing a key is asking for the state now; only a timer gets throttled.
  store.addPeer("dev", "dev.example");
  const { channel, calls } = counting(() => snapshot([pane("%1")]));

  await collect(store, channel, 1_000);
  await collect(store, channel, 1_001);
  await collect(store, channel, 1_002);
  expect(calls()).toBe(3);
});

test("the floor leaves room for two attempts inside a staleness window", async () => {
  // The ceiling on COLLECT_FLOOR_MS is not arbitrary. A floor at or above
  // STALENESS_MS would drive a REACHABLE peer into `stale` on its own and make
  // the HUD flap; at half, a peer has to miss two consecutive attempts first.
  expect(COLLECT_FLOOR_MS).toBeLessThan(STALENESS_MS);
  expect(COLLECT_FLOOR_MS * 2).toBeLessThanOrEqual(STALENESS_MS);
});

test("an unfloored collect fetches even if a peer's attempt stamp is in the future", async () => {
  // Why `floorMs <= 0` short-circuits instead of falling through to the
  // arithmetic. With no floor the comparison would be `now - attempt >= 0`,
  // which is false when the stored stamp is AHEAD of now -- so a clock stepping
  // backwards, an NTP correction, or a stamp written by a peer's clock would
  // make an unfloored collect silently skip. "No floor" has to mean no floor.
  store.addPeer("dev", "dev.example");
  const { channel, calls } = counting(() => snapshot([pane("%1")]));

  await collect(store, channel, 9_000);
  expect(calls()).toBe(1);
  // Now is EARLIER than the recorded attempt.
  await collect(store, channel, 5_000);
  expect(calls()).toBe(2);
});

/**
 * One edge of the jitter window: with `random` pinned, a peer must be skipped at
 * `notDueAt` and fetched at `dueAt`.
 *
 * Takes the per-test store rather than opening its own -- MURMUR_STATE_DIR is
 * set per test, not per call, so a second `openStore()` here reopens the SAME
 * database and inherits the first peer's attempt stamp.
 */
async function assertWindowEdge(
  random: () => number,
  notDueAt: number,
  dueAt: number,
): Promise<void> {
  store.addPeer("dev", "dev.example");
  const { channel, calls } = counting(() => snapshot([pane("%1")]));
  const options = { floorMs: 30_000, random };

  // Attempt recorded at t=0, so the later timestamps are elapsed time.
  await collect(store, channel, 0, options);
  expect(calls()).toBe(1);
  await collect(store, channel, notDueAt, options);
  expect(calls(), "must not be due yet").toBe(1);
  await collect(store, channel, dueAt, options);
  expect(calls(), "must be due").toBe(2);
}

// Both edges are asserted because a one-sided window is the easy mistake: it
// buys the same spread by quietly stretching every peer's mean period, which
// makes all data older to solve a problem about simultaneity.

test("the earliest jitter draw brings a peer due before the floor", async () => {
  // random() = 0 => -span/2 => floor - 10s.
  await assertWindowEdge(() => 0, 19_999, 20_000);
});

test("the latest jitter draw holds a peer past the floor", async () => {
  // random() approaching 1 => +span/2 => floor + 10s.
  await assertWindowEdge(() => 1, 39_999, 40_000);
});

test("the jitter is drawn per peer, not once per collect", async () => {
  // The property that actually breaks a herd. One draw shared across peers would
  // move them all by the same offset, which keeps them synchronised with each
  // other -- exactly the state the jitter exists to leave.
  store.addPeer("a", "a.example");
  store.addPeer("b", "b.example");
  store.addPeer("c", "c.example");
  const draws: number[] = [];
  const { channel } = counting(() => snapshot([pane("%1")]));

  await collect(store, channel, 0, {
    floorMs: 30_000,
    random: () => {
      draws.push(draws.length);
      return 0.5;
    },
  });
  // First run: nothing has been attempted, so every peer is due without a draw.
  expect(draws).toHaveLength(0);

  await collect(store, channel, 25_000, {
    floorMs: 30_000,
    random: () => {
      draws.push(draws.length);
      return 0.5;
    },
  });
  // One draw per peer with a recorded attempt.
  expect(draws).toHaveLength(3);
});

test("jitter never applies without a floor", async () => {
  // An unfloored collect is a person asking for the state now -- `murmur
  // collect`, the picker, and its `^r` reload. A random skip there would be a
  // keypress that sometimes silently does nothing.
  store.addPeer("dev", "dev.example");
  const { channel, calls } = counting(() => snapshot([pane("%1")]));
  let draws = 0;
  const random = () => {
    draws += 1;
    return 0; // the earliest edge, which would shorten any floor
  };

  await collect(store, channel, 0, { random });
  await collect(store, channel, 1, { random });
  await collect(store, channel, 2, { random });
  expect(calls()).toBe(3);
  expect(draws).toBe(0);
});

test("an unlucky draw still cannot push a peer into staleness", async () => {
  // The load-bearing constraint on the span. If the latest possible fetch fell
  // at or after STALENESS_MS, a REACHABLE peer would cross the staleness line on
  // its own and the HUD would flap between fresh and stale.
  expect(COLLECT_FLOOR_MS + COLLECT_JITTER_MS / 2).toBeLessThan(STALENESS_MS);
  // And the earliest edge stays positive, so jitter can never mean "always due".
  expect(COLLECT_JITTER_MS / 2).toBeLessThan(COLLECT_FLOOR_MS);
});

test("an auth refusal is distinguished from an unreachable host", () => {
  // Real strings, captured from a 2FA-gated host and from a proxy that could not
  // establish anything. Both arrive as `last_error`, and conflating them is the
  // bug: only the first is fixable by the operator running `ssh <host>`.
  //
  // The host this exists for answers `publickey` with *partial success* and then
  // demands `keyboard-interactive`, which no cached credential satisfies.
  expect(needsInteractiveAuth("Permission denied (keyboard-interactive).")).toBe(true);
  // Any `Permission denied`, not the 2FA spelling: a publickey-only refusal is
  // the same problem for an operator and has the same remedy.
  expect(needsInteractiveAuth("Permission denied (publickey).")).toBe(true);

  // MUST NOT match. This is an x2ssh proxy failing to establish a connection at
  // all, which `isUnreachable` already claims correctly -- and treating it as an
  // auth problem would tell the operator to re-authenticate at a host that is
  // simply unreachable. It is also the error the local `dev` peer currently
  // holds, so getting this wrong would fire the prompt on the wrong evidence.
  expect(needsInteractiveAuth("Connection closed by UNKNOWN port 65535")).toBe(false);
  expect(needsInteractiveAuth("ssh: connect to host dev port 22: Operation timed out")).toBe(false);
  expect(needsInteractiveAuth("Host is down")).toBe(false);
});

test("the auth category does not overlap unreachability", () => {
  // `isUnreachable` deliberately excludes `Permission denied` -- an auth
  // misconfiguration is reachable-but-broken and an operator task, not a
  // sleeping host. This pins that the new category is disjoint from it by
  // construction rather than by which check happens to run first.
  const auth = "Permission denied (keyboard-interactive).";

  expect(needsInteractiveAuth(auth)).toBe(true);
  expect(describeFailure("dev", auth)).not.toContain("unreachable");
});
