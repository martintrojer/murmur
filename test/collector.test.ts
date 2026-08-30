import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { Channel } from "../src/channel.js";
import { collect, describeFailure, MAX_CONCURRENT_PEERS } from "../src/collector.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { openStore, type Store } from "../src/store.js";
import type { Snapshot, SnapshotPane } from "../src/types.js";

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
