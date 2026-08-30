import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { Channel } from "../src/channel.js";
import { collect } from "../src/collector.js";
import { exportJsonl, SCHEMA_VERSION } from "../src/export.js";
import { ensureIdentity } from "../src/identity.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { type NewEvent, openStore, type Store } from "../src/store.js";
import type { AgentState } from "../src/types.js";

/**
 * Two real nodes, each with its own state dir, talking over a fake ssh.
 *
 * The holes under test are both about what one node's watermark believes about
 * ANOTHER node's log, so a single store cannot express them. `openStore` and
 * `ensureIdentity` both read $MURMUR_STATE_DIR, so a node is exactly "a state
 * dir", and swapping the variable is what makes two of them possible in one
 * process.
 */
type Node = {
  dir: string;
  hostId: string;
  /** Run `fn` with this node's state dir active, on a store of its own. */
  with: <T>(fn: (store: Store) => T | Promise<T>) => Promise<T>;
  /**
   * What `resetIfStale` does on a STORE_VERSION change: delete events.db and
   * its sidecars, leaving identity.json alone.
   *
   * Deleting the FILE, not the rows, and the difference is the whole scenario.
   * `forgetHost` empties the log but keeps the database, so the node stays the
   * same incarnation -- which is a manual eviction and is correctly NOT treated
   * as a reset. Only a new file is a new log. My first draft of this test used
   * forgetHost and therefore could never have gone green.
   *
   * Not driven by actually bumping STORE_VERSION, because that is a source
   * edit. The observable state a bump leaves behind is what matters: this
   * host_id, a fresh log, seqs from 1.
   */
  wipeStore: () => void;
};

const opened: Store[] = [];

function node(prefix: string): Node {
  const saved = process.env.MURMUR_STATE_DIR;
  const dir = mkdtempSync(join(tmpdir(), `murmur-${prefix}-`));
  process.env.MURMUR_STATE_DIR = dir;
  const hostId = ensureIdentity().host_id;
  if (saved === undefined) delete process.env.MURMUR_STATE_DIR;
  else process.env.MURMUR_STATE_DIR = saved;

  return {
    dir,
    hostId,
    // Async and awaited, which is not incidental. A synchronous `finally` that
    // closes the store returns the moment an async `fn` hits its first await,
    // so the callback then runs against a closed handle -- "The database
    // connection is not open", as an UNHANDLED REJECTION that vitest reports
    // separately from the test. The env swap has the same hazard: it must not
    // be restored until the work that depends on it is done.
    wipeStore() {
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(join(dir, `events.db${suffix}`), { force: true });
      }
    },
    async with(fn) {
      const previous = process.env.MURMUR_STATE_DIR;
      process.env.MURMUR_STATE_DIR = dir;
      const store = openStore();
      opened.push(store);
      try {
        return await fn(store);
      } finally {
        store.close();
        opened.splice(opened.indexOf(store), 1);
        if (previous === undefined) delete process.env.MURMUR_STATE_DIR;
        else process.env.MURMUR_STATE_DIR = previous;
      }
    },
  };
}

afterEach(() => {
  for (const store of opened.splice(0)) store.close();
  delete process.env.MURMUR_STATE_DIR;
});

function event(state: AgentState, pane: string): NewEvent {
  return {
    agent_id: `agent-${pane}`,
    session: asSessionId("$0"),
    window: asWindowId("@1"),
    pane: asPaneId(pane),
    workstream: null,
    role: null,
    cli: "pi",
    driver: "human",
    kind: "state",
    state,
    message: "",
    pid: null,
    synthetic: false,
    reason: "",
    extra: {},
  };
}

/** A channel that answers `murmur export --since N` from the owner's store. */
function ownerChannel(owner: Node): Channel {
  return {
    exec: async (_target, args) => {
      const since = Number(args[args.indexOf("--since") + 1]);
      return owner.with((store) => exportJsonl(store, since, () => true));
    },
  };
}

test("HOLE 2: a store reset must not make a node invisible to its peers", async () => {
  // THE BAD ONE, and the reason this task is impact 90. Reproduced before any
  // fix was written.
  //
  //   owner reaches maxSeq 3, then STORE_VERSION is bumped and resetIfStale
  //   wipes its events. host_id SURVIVES -- identity.json is a separate file --
  //   so the owner's seq restarts at 1 and it re-reports two BLOCKED agents at
  //   seq 1 and 2.
  //
  //   the peer is holding watermark 3. It asks `--since 3` and receives
  //   NOTHING, because the owner's whole log is now below its watermark.
  //
  // Two agents waiting on a human, invisible indefinitely, with no detection
  // and no recovery. store.ts reasons carefully about resetting the READER's
  // watermark and misses that a PEER holds one about us.
  const owner = node("owner");
  const peer = node("peer");

  // `done`, not `working`, and that is a fixture detail worth knowing: export
  // runs synthesizeCrashes, and a `working` row with a null pid folds to
  // crashed, so the owner would append synthetic rows mid-test and the
  // watermark would land at 5 instead of 3. The states here are scenery; the
  // seq numbers are the subject.
  await owner.with((store) => {
    store.append(event("done", "%1"));
    store.append(event("done", "%2"));
    store.append(event("done", "%3"));
    expect(store.maxSeq(owner.hostId)).toBe(3);
  });

  await peer.with(async (store) => {
    store.upsertPeer({ name: "owner", target: "owner-host" });
    await collect(store, ownerChannel(owner));
    expect(store.peers()[0]?.watermark).toBe(3);
  });

  // The reset itself. See `wipeStore`.
  owner.wipeStore();
  await owner.with((store) => {
    store.append(event("blocked", "%1"));
    store.append(event("blocked", "%2"));
    // Same node, fresh log: the identity survived and the seqs restarted, which
    // is exactly the pair that made this undetectable.
    expect(store.maxSeq(owner.hostId)).toBe(2);
  });

  await peer.with(async (store) => {
    await collect(store, ownerChannel(owner));

    // What the peer must end up believing: both blocked agents are visible.
    const states = store
      .allEvents()
      .filter((item) => item.host_id === owner.hostId)
      .map((item) => item.state);
    expect(states).toEqual(["blocked", "blocked"]);
  });
});

test("HOLE 1: a reset republishes seqs the peer already has, and must not keep the stale rows", async () => {
  // The deletion half, in the shape this task can actually close. A general
  // tombstone for `forgetAgent` is the snapshot-protocol task; what the epoch
  // fixes is the reset case, where the owner's log is not merely missing rows
  // but has RE-USED their seq numbers.
  //
  // This is worse than a plain absence and is why re-reading from zero is not
  // sufficient on its own: ingest is INSERT OR IGNORE on (host_id, seq), so
  // rows from the OLD incarnation sitting at seq 1-2 silently win over the new
  // incarnation's seq 1-2. The peer would re-read from zero and still show the
  // superseded agents.
  const owner = node("owner2");
  const peer = node("peer2");

  await owner.with((store) => {
    store.append(event("done", "%9"));
    store.append(event("done", "%8"));
  });

  await peer.with(async (store) => {
    store.upsertPeer({ name: "owner", target: "owner-host" });
    await collect(store, ownerChannel(owner));
    expect(store.allEvents().filter((item) => item.host_id === owner.hostId)).toHaveLength(2);
  });

  // New incarnation, same host_id, DIFFERENT agents at the same seq numbers.
  owner.wipeStore();
  await owner.with((store) => {
    store.append(event("blocked", "%1"));
    store.append(event("blocked", "%2"));
  });

  await peer.with(async (store) => {
    await collect(store, ownerChannel(owner));

    const panes = store
      .allEvents()
      .filter((item) => item.host_id === owner.hostId)
      .map((item) => item.pane)
      .sort();
    // The old incarnation's agents are gone, not merely outnumbered.
    expect(panes).toEqual(["%1", "%2"]);
  });
});

test("the epoch is additive on the wire, so it needs no SCHEMA_VERSION bump", async () => {
  // The claim this whole design rests on, proved rather than assumed — and the
  // stakes are the reason. A SCHEMA_VERSION bump is a WIRE change, but
  // `resetIfStale` deletes every local events.db on a STORE_VERSION change, and
  // the two are easy to conflate: bumping the wire "to announce" a
  // wipe-detection field would be a change whose whole purpose is surviving
  // wipes, shipped in a way that causes one.
  //
  // Additive means tolerated in BOTH directions, so both are checked.
  const owner = node("compat");
  const peer = node("compat-peer");

  await owner.with((store) => {
    store.append(event("done", "%1"));
  });

  // Direction 1: a NEW owner's envelope carries the epoch, and it does so at
  // the unchanged SCHEMA_VERSION. If someone bumps the wire for this field,
  // this fails and says why.
  const wire = await owner.with((store) => exportJsonl(store, 0, () => true));
  const envelope = JSON.parse(wire.trim().split("\n")[0] ?? "{}") as Record<string, unknown>;
  expect(envelope.epoch).toEqual(expect.any(String));
  // The LITERAL 2, not the SCHEMA_VERSION constant, and mutation testing is why:
  // comparing the wire against the constant passes no matter what the constant
  // is, so it cannot notice a bump -- I checked, and it did not. Pinning the
  // number means the test fails if the wire version moves, which is the event
  // this is here to catch. If a bump is ever genuinely wanted, this line is the
  // place that makes you justify it: every local events.db is deleted by
  // resetIfStale on a STORE_VERSION change, and the two constants are one
  // careless edit apart.
  expect(envelope.schema_version).toBe(2);
  expect(SCHEMA_VERSION).toBe(2);

  // Direction 2: an OLD owner sends no epoch at all. A new reader must treat
  // that as "unknown", not as "changed" — otherwise every collect against an
  // un-upgraded peer re-reads its entire log, forever.
  const oldChannel: Channel = {
    exec: async (_target, args) => {
      const since = Number(args[args.indexOf("--since") + 1]);
      const lines = (await owner.with((store) => exportJsonl(store, since, () => true)))
        .trim()
        .split("\n");
      const { epoch: _dropped, ...withoutEpoch } = JSON.parse(lines[0] ?? "{}") as Record<
        string,
        unknown
      >;
      return [JSON.stringify(withoutEpoch), ...lines.slice(1)].join("\n");
    },
  };

  await peer.with(async (store) => {
    store.upsertPeer({ name: "owner", target: "owner-host" });
    await collect(store, oldChannel);
    expect(store.peers()[0]?.watermark).toBe(1);
    expect(store.peers()[0]?.epoch).toBeNull();

    // The second collect must be a no-op: nothing new, and no re-read.
    const reads: string[] = [];
    await collect(store, {
      exec: async (target, args) => {
        reads.push(args.join(" "));
        return oldChannel.exec(target, args);
      },
    });
    expect(reads).toEqual(["murmur export --since 1"]);
  });
});

test("a stable peer is never re-read, however many times we collect", async () => {
  // The cost guard. The recovery is a SECOND round trip, so it must fire only on
  // an actual change; a comparison that misfired would double every collect
  // against every healthy peer and turn a status-bar tick into a full log
  // re-read.
  const owner = node("stable");
  const peer = node("stable-peer");

  await owner.with((store) => {
    store.append(event("done", "%1"));
  });

  await peer.with(async (store) => {
    store.upsertPeer({ name: "owner", target: "owner-host" });
    const reads: string[] = [];
    const counted: Channel = {
      exec: async (target, args) => {
        reads.push(args.join(" "));
        return ownerChannel(owner).exec(target, args);
      },
    };

    await collect(store, counted);
    await collect(store, counted);
    await collect(store, counted);

    // One request per collect, and the watermark advances rather than resetting.
    expect(reads).toEqual([
      "murmur export --since 0",
      "murmur export --since 1",
      "murmur export --since 1",
    ]);
    expect(store.peers()[0]?.epoch).toEqual(expect.any(String));
  });
});

test("a fresh database mints a new epoch, and reopening the same one keeps it", async () => {
  // The property that makes this correct by construction rather than by anyone
  // remembering to bump a counter: the epoch lives IN the database, so the wipe
  // that resets `seq` is the same wipe that takes the epoch with it. A new
  // reason to reset gets the behaviour for free.
  const subject = node("epoch");

  const first = await subject.with((store) => store.epoch());
  const reopened = await subject.with((store) => store.epoch());
  expect(reopened).toBe(first);

  subject.wipeStore();
  const afterWipe = await subject.with((store) => store.epoch());
  expect(afterWipe).not.toBe(first);
  expect(afterWipe).toEqual(expect.any(String));
});
