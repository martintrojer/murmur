import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { Channel } from "../src/channel.js";
import { collect, describeFailure, MAX_CONCURRENT_PEERS } from "../src/collector.js";
import { SCHEMA_VERSION } from "../src/export.js";
import { openStore, type Store } from "../src/store.js";
import type { Event } from "../src/types.js";

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

function event(seq: number, hostId = "remote-host"): Event {
  return {
    host_id: hostId,
    seq,
    ts: Date.now() + seq,
    agent_id: "agent",
    session: "session",
    window: "window",
    pane: "pane",
    session_name: null,
    window_name: null,
    agent_name: null,
    pi_session: null,
    workstream: null,
    role: null,
    cli: null,
    driver: null,
    kind: "state",
    state: "working",
    message: "",
    pid: null,
    synthetic: false,
    reason: "",
    extra: {},
  };
}

function jsonl(events: Event[], hostId = "remote-host", version = SCHEMA_VERSION): string {
  return [
    JSON.stringify({
      schema_version: version,
      host_id: hostId,
      display_name: "Remote",
      exported_at: 1_000,
    }),
    ...events.map((item) => JSON.stringify(item)),
  ].join("\n");
}

test("collect ingests and advances the watermark", async () => {
  store.upsertPeer({ name: "dev", target: "dev.example" });
  const channel: Channel = {
    exec: async (target, argv) => {
      expect(target).toBe("dev.example");
      expect(argv).toEqual(["murmur", "export", "--since", "0"]);
      return jsonl([event(1), event(2)]);
    },
  };

  await expect(collect(store, channel, 5_000)).resolves.toEqual([
    { peer: "dev", ok: true, ingested: 2 },
  ]);
  expect(store.allEvents()).toHaveLength(2);
  expect(store.peers()[0]).toMatchObject({
    name: "dev",
    host_id: "remote-host",
    display_name: "Remote",
    watermark: 2,
    fetched_at: 5_000,
  });
});

test("a failing peer does not throw and leaves fetched_at stale", async () => {
  store.upsertPeer({ name: "dev", target: "dev", fetched_at: 123 });
  store.upsertPeer({ name: "prod", target: "prod" });
  const channel: Channel = {
    exec: async (target) => {
      if (target === "dev") throw new Error("authentication required");
      return jsonl([event(1)]);
    },
  };

  const result = await collect(store, channel, 5_000);

  expect(result).toEqual([
    { peer: "dev", ok: false, ingested: 0, error: "authentication required", unreachable: false },
    { peer: "prod", ok: true, ingested: 1 },
  ]);
  expect(store.peers()[0]?.fetched_at).toBe(123);
  expect(store.peers()[1]?.fetched_at).toBe(5_000);
});

test("a second collect with no new events is a no-op", async () => {
  store.upsertPeer({ name: "dev", target: "dev" });
  const since: string[] = [];
  const channel: Channel = {
    exec: async (_target, argv) => {
      since.push(argv.at(-1) ?? "");
      return since.length === 1 ? jsonl([event(1), event(2)]) : jsonl([]);
    },
  };

  expect(await collect(store, channel, 5_000)).toEqual([{ peer: "dev", ok: true, ingested: 2 }]);
  expect(await collect(store, channel, 6_000)).toEqual([{ peer: "dev", ok: true, ingested: 0 }]);
  expect(since).toEqual(["0", "2"]);
  expect(store.allEvents()).toHaveLength(2);
  expect(store.peers()[0]?.watermark).toBe(2);
});

test("peers are fetched concurrently, so a slow peer does not hold up the rest", async () => {
  // The regression this guards: a serial loop charged every peer the full ssh
  // timeout of the peer ahead of it, so three asleep laptops froze the HUD.
  for (const name of ["a", "b", "c"]) store.upsertPeer({ name, target: name });
  let inFlight = 0;
  let peak = 0;
  const channel: Channel = {
    exec: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return jsonl([event(1)]);
    },
  };

  const results = await collect(store, channel, 5_000);

  expect(peak).toBe(3);
  expect(results.map((item) => item.peer)).toEqual(["a", "b", "c"]);
});

test("fan-out is capped, and every peer still gets collected in order", async () => {
  // The roof matters because each in-flight peer is its own forked ssh client
  // process, and a cold one holds that process for the full connect
  // timeout. A long peer list must not put all of them resident at once.
  const names = Array.from({ length: MAX_CONCURRENT_PEERS * 3 }, (_, i) =>
    String(i).padStart(2, "0"),
  );
  for (const name of names) store.upsertPeer({ name, target: name });
  let inFlight = 0;
  let peak = 0;
  const channel: Channel = {
    exec: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return jsonl([event(1)]);
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
  for (const name of names) store.upsertPeer({ name, target: name });
  let slowDone = false;
  const startedAfterSlowFinished: string[] = [];
  const channel: Channel = {
    exec: async (target) => {
      if (slowDone) startedAfterSlowFinished.push(target);
      await new Promise((resolve) => setTimeout(resolve, target === "p0" ? 60 : 1));
      if (target === "p0") slowDone = true;
      return jsonl([event(1)]);
    },
  };

  await collect(store, channel, 5_000);

  // The two peers past the cap start while p0 is still hanging, because the
  // fast slots recycle. A fixed-batch chunker would not have started either of
  // them until p0 resolved.
  expect(startedAfterSlowFinished).toEqual([]);
});

test("a peer that fails late is reported, not an unhandled rejection", async () => {
  store.upsertPeer({ name: "slow", target: "slow" });
  store.upsertPeer({ name: "fast-fail", target: "fast-fail" });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const channel: Channel = {
    exec: async (target) => {
      if (target === "fast-fail") throw new Error("boom");
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonl([event(1)]);
    },
  };

  try {
    const results = await collect(store, channel, 5_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(results).toEqual([
      { peer: "fast-fail", ok: false, ingested: 0, error: "boom", unreachable: false },
      { peer: "slow", ok: true, ingested: 1 },
    ]);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("host_id on ingested rows is the origin, not the peer name", async () => {
  store.upsertPeer({ name: "dev", target: "dev" });
  const channel: Channel = { exec: async () => jsonl([event(1, "H")], "H") };

  await collect(store, channel);

  expect(store.allEvents()[0]?.host_id).toBe("H");
});

test("a collect with no peers still prunes", async () => {
  // The single-machine path: nobody to fetch from, but the retention horizon is
  // a property of the log, not of federation. This used to prune only inside
  // the per-peer loop, so a laptop with no peers grew events forever.
  const stale = Date.now() - 30 * 86_400_000;
  store.ingest([
    { ...event(1, "local"), agent_id: "a", ts: stale },
    { ...event(2, "local"), agent_id: "a", ts: stale + 1 },
  ]);
  expect(store.allEvents()).toHaveLength(2);

  await collect(store, { exec: async () => "" });

  // The newest event per agent is kept regardless of age, or the agent would
  // vanish from the picker rather than reading as old.
  expect(store.allEvents().map((item) => item.seq)).toEqual([2]);
});

test("prune runs once per collect, not once per peer", async () => {
  for (const name of ["a", "b", "c"]) store.upsertPeer({ name, target: name });
  let prunes = 0;
  const spy = new Proxy(store, {
    get: (target, prop, receiver) =>
      prop === "prune"
        ? () => {
            prunes += 1;
            return 0;
          }
        : Reflect.get(target, prop, receiver),
  });
  const channel: Channel = { exec: async () => jsonl([event(1)]) };

  await collect(spy, channel, 5_000);

  expect(prunes).toBe(1);
});

test("a failing prune is silent and does not fail the collect", async () => {
  store.upsertPeer({ name: "dev", target: "dev" });
  const spy = new Proxy(store, {
    get: (target, prop, receiver) =>
      prop === "prune"
        ? () => {
            throw new Error("database is locked");
          }
        : Reflect.get(target, prop, receiver),
  });
  const channel: Channel = { exec: async () => jsonl([event(1)]) };

  // Capture stderr and require it to stay EMPTY. collect runs from `status` on
  // every status-bar tick and from `pick` inside a popup, so anything it prints
  // is printed forever and into a UI. Retention failing is housekeeping the
  // next collect retries; there is no one on this path to tell.
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    await expect(collect(spy, channel, 5_000)).resolves.toEqual([
      { peer: "dev", ok: true, ingested: 1 },
    ]);
  } finally {
    process.stderr.write = original;
  }

  expect(written.join("")).toBe("");
});

test("an empty peer list touches no channel", async () => {
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

test("a re-seen event still clears tmux_down after a partial apply", async () => {
  // The insert count was the wrong signal. ingest is INSERT OR IGNORE, so a
  // collect that stored rows and then failed before upsertPeer leaves the old
  // watermark; the retry re-fetches the same events, inserts nothing, and the
  // count reads 0 even though the peer has demonstrably authored past its
  // watermark. Keying on the watermark advancing fixes it.
  store.upsertPeer({ name: "p", target: "p", host_id: "H", tmux_down_at: 1_000, watermark: 0 });
  store.ingest([event(1, "H")]); // already stored by the run that then failed

  const channel: Channel = { exec: async () => jsonl([event(1, "H")], "H") };
  const result = await collect(store, channel, 5_000);

  expect(result).toEqual([{ peer: "p", ok: true, ingested: 0 }]);
  expect(store.peers()[0]?.watermark).toBe(1);
  expect(store.peers()[0]?.tmux_down_at).toBeNull();
});

test("relayed events from another origin do not clear tmux_down", async () => {
  // ingest counts every row, including ones this peer merely relayed from a
  // third host. Those say nothing about whether this peer's own tmux is back.
  store.upsertPeer({ name: "p", target: "p", host_id: "H", tmux_down_at: 1_000 });
  const channel: Channel = { exec: async () => jsonl([event(7, "OTHER")], "H") };

  const result = await collect(store, channel, 5_000);

  expect(result).toEqual([{ peer: "p", ok: true, ingested: 1 }]);
  expect(store.peers()[0]?.tmux_down_at).toBe(1_000);
});

test("the collect deadline abandons peers instead of waiting out every wave", async () => {
  // The per-peer timeout applies once per wave, so MAX_CONCURRENT_PEERS + 1
  // unreachable peers cost two waves and overrun the status tick. The deadline
  // bounds the whole collect regardless of peer count.
  // Zero-padded: peers come back ordered by name, and `p10` sorts before `p2`.
  const names = Array.from(
    { length: MAX_CONCURRENT_PEERS + 4 },
    (_, i) => `p${String(i).padStart(2, "0")}`,
  );
  for (const name of names) store.upsertPeer({ name, target: name });
  let started = 0;
  const channel: Channel = {
    exec: async () => {
      started += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return jsonl([event(1)]);
    },
  };
  // Fires after the first wave is in flight but before it completes.
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, 10));

  const results = await collect(store, channel, 5_000, deadline);

  // Every peer still gets a result, in order: the ones past the deadline are
  // reported as failures rather than silently dropped.
  expect(results.map((item) => item.peer)).toEqual(names);
  expect(results.some((item) => !item.ok)).toBe(true);
  expect(results.find((item) => !item.ok)?.error).toMatch(/deadline/);

  // And the pool actually stopped, rather than the deadline merely returning
  // early while workers kept dialling in the background. Measured after the
  // first wave has had time to drain: without the expired guard the freed
  // slots would pick up the remaining peers and spawn more ssh.
  const duringCollect = started;
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(started).toBe(duringCollect);
  expect(started).toBeLessThanOrEqual(MAX_CONCURRENT_PEERS);
});

test("a peer abandoned by the deadline stays stale rather than looking fresh", async () => {
  store.upsertPeer({ name: "slow", target: "slow", fetched_at: 111 });
  const channel: Channel = {
    exec: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return jsonl([event(1)]);
    },
  };

  await collect(store, channel, 5_000, Promise.resolve());

  expect(store.peers()[0]?.fetched_at).toBe(111);
});

test("new events clear a tmux_down mark, an empty export does not", async () => {
  // The race: a jump proves the peer's tmux is down, then the host comes back.
  // The log settles it — but only a real event counts. A successful export
  // proves the murmur binary ran, which it does happily on a host whose tmux
  // server is gone; treating that as recovery is what let a dead bubba read as
  // healthy for three hours.
  const store = openStore();
  store.upsertPeer({ name: "p", target: "p", host_id: "H", tmux_down_at: 1_000 });

  const empty: Channel = { exec: async () => jsonl([], "H") };
  await collect(store, empty);
  expect(store.peers()[0]?.tmux_down_at).toBe(1_000);

  const withEvent: Channel = { exec: async () => jsonl([event(1, "H")], "H") };
  await collect(store, withEvent);
  expect(store.peers()[0]?.tmux_down_at).toBeNull();
});

test("an older wire version is accepted, a newer one is refused", async () => {
  // The version rules are asymmetric on purpose and only half of it was
  // covered: every other test in this file used to hardcode version 1, so the
  // current version was never exercised on ingest and the rejection branch had
  // no test at all.
  store.upsertPeer({ name: "old", target: "old" });
  store.upsertPeer({ name: "new", target: "new", fetched_at: 42 });

  const channel: Channel = {
    exec: async (target) =>
      target === "old"
        ? // Older peer: forward compatible, so its events land.
          jsonl([event(1, "OLD")], "OLD", SCHEMA_VERSION - 1)
        : // Newer peer: we cannot know what its fields mean, so refuse rather
          // than half-parse it.
          jsonl([event(1, "NEW")], "NEW", SCHEMA_VERSION + 1),
  };

  const results = await collect(store, channel, 5_000);

  expect(results).toEqual([
    {
      peer: "new",
      ok: false,
      ingested: 0,
      error: expect.stringContaining("unsupported schema"),
      unreachable: false,
    },
    { peer: "old", ok: true, ingested: 1 },
  ]);
  // The refused peer keeps its old fetched_at, so it renders stale rather than
  // looking freshly synced.
  expect(store.peers().find((peer) => peer.name === "new")?.fetched_at).toBe(42);
  expect(store.allEvents().map((item) => item.host_id)).toEqual(["OLD"]);
});

test("collect never writes to stderr, whatever the peer does", async () => {
  // The contract that makes the polling paths usable. `collect` is called by
  // `murmur status` on every tmux status-bar tick and by `pick` inside a
  // display-popup. It used to print two lines of ssh diagnostics per failed
  // peer -- the full ssh invocation plus ssh's own message, over 200 characters
  // -- so one sleeping laptop wrote to stderr several times a minute forever,
  // and into a popup. The author's own tmux status script had to pass
  // stderr=DEVNULL to defend against it, which is the tell that the output was
  // wrong rather than merely verbose.
  //
  // A fleet normally has nodes that are off or asleep, so this is the common
  // case, not a fault worth a log line. Failures travel in the return value;
  // only the `collect` command prints them.
  store.upsertPeer({ name: "down", target: "down" });
  store.upsertPeer({ name: "broken", target: "broken" });

  const channel: Channel = {
    exec: async (target) => {
      if (target === "down") {
        throw new Error(
          "Command failed: ssh -o BatchMode=yes down murmur export --since 0\nssh: connect to host down port 22: Host is down",
        );
      }
      throw new Error("unsupported schema version 99");
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

  // And the information is not lost -- it is in the result, including which
  // kind of failure it was, so a caller can report a broken peer while staying
  // quiet about a sleeping one.
  const byPeer = new Map(results.map((result) => [result.peer, result]));
  expect(byPeer.get("down")?.unreachable).toBe(true);
  expect(byPeer.get("broken")?.unreachable).toBe(false);
});

test("a peer failure is described in one line a human can act on", () => {
  // The raw error is the whole ssh command line plus ssh's message. The
  // actionable part is the host and the reason; the ssh options are murmur's
  // own and the user cannot do anything about them.
  expect(
    describeFailure(
      "linuxpc",
      "Command failed: ssh -o BatchMode=yes -o ControlPath=~/.ssh/control/%r@%h:%p linuxpc murmur export --since 0\nssh: connect to host linuxpc port 22: Host is down",
    ),
  ).toBe("linuxpc: unreachable (Host is down)");

  // A reachable peer that answers wrongly keeps its message, because that IS
  // the diagnosis, but bounded so a corrupt export cannot print a screenful.
  expect(describeFailure("dev", "unsupported schema version 99 (supports 2)")).toBe(
    "dev: unsupported schema version 99 (supports 2)",
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
});
