import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { Channel } from "../src/channel.js";
import { collect } from "../src/collector.js";
import { ensureIdentity } from "../src/identity.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { status } from "../src/status.js";
import { openStore, type Store } from "../src/store.js";
import type { Event } from "../src/types.js";

let store: Store;
let hostId: string;

/**
 * A pid that existed and is gone, so `pidAlive` reports ESRCH.
 *
 * Not 0, and this distinction is the point. `fold` short-circuits on
 * `pid !== null && pid > 0` BEFORE it consults isAlive, so a row with pid 0
 * reads as crashed for any reader — including a remote one, which is supposed
 * to be unable to tell. That made the peer test below pass before the fix and
 * proved nothing. A real reaped pid is the only value that exercises the pid
 * CHECK rather than the guard in front of it.
 */
const DEAD_PID = spawnSync(process.execPath, ["-e", ""]).pid ?? 2 ** 30;

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-synth-"));
  hostId = ensureIdentity().host_id;
  store = openStore();
});

afterEach(() => {
  store.close();
});

/** A `working` row for this host, owned by a pid that cannot be alive. */
function working(seq: number, over: Partial<Event> = {}): Event {
  return {
    host_id: hostId,
    seq,
    ts: Date.now() + seq,
    agent_id: `${hostId}:%1`,
    session: asSessionId("$0"),
    window: asWindowId("@1"),
    pane: asPaneId("%1"),
    session_name: null,
    window_name: null,
    agent_name: null,
    pi_session: null,
    workstream: null,
    role: null,
    cli: "pi",
    driver: "human",
    kind: "state",
    state: "working",
    message: "",
    pid: DEAD_PID,
    synthetic: false,
    reason: "",
    extra: {},
    ...over,
  };
}

/** No peers, no ssh. The single-machine case, which is the whole point. */
const noPeers: Channel = { exec: async () => "" };

test("a node with no peers records a crash of its own accord", async () => {
  // The bug: synthesizeCrashes was only reached from exportJsonl, which runs
  // when a PEER asks over ssh. A single-machine node synthesized never, and a
  // node whose peers are asleep — the normal case for this tool — only when one
  // happened to wake. Live store evidence was 438 raw `working` rows against 2
  // `crashed`.
  //
  // Exactly the structural mistake reapDeadAgents was moved out of export to
  // fix; crash synthesis was the half left behind.
  store.ingest([working(1)]);
  expect(store.allEvents().filter((event) => event.state === "crashed")).toHaveLength(0);

  await collect(store, noPeers);

  const crashed = store.allEvents().filter((event) => event.state === "crashed");
  expect(crashed).toHaveLength(1);
  expect(crashed[0]).toMatchObject({
    agent_id: `${hostId}:%1`,
    state: "crashed",
    synthetic: true,
    reason: "pid_gone",
  });
});

test("the written row and the derived read agree", async () => {
  // The constraint the task note names: this changes what gets WRITTEN, not
  // what a reader derives, so it must not move the fold. A LOCAL reader already
  // saw `crashed` here by checking the pid itself — synthesis has to agree with
  // that, not compete with it.
  store.ingest([working(1)]);
  const before = status(store).agents.map((agent) => agent.state);

  await collect(store, noPeers);

  expect(before).toEqual(["crashed"]);
  expect(status(store).agents.map((agent) => agent.state)).toEqual(before);
  // And one agent, not two: a synthetic row about an agent that already has one
  // must supersede it in the fold rather than forking the row.
  expect(status(store).agents).toHaveLength(1);
});

test("the synthetic row is what lets a PEER ever see the crash", async () => {
  // Why this matters after the picker and clear were fixed to fold correctly,
  // and why it is not merely cosmetic.
  //
  // A reader folds a REMOTE `working` row with `() => true` (status.ts), because
  // a remote pid names a process in another machine's process table and means
  // nothing locally. So a peer CANNOT derive `crashed` for this host's agents,
  // ever. If this node does not write the row, no node learns the fact.
  //
  // Modelled by folding the same events as a remote replica would: without the
  // synthetic row the agent reads `working` forever; with it, `crashed`.
  store.ingest([working(1)]);
  const raw = store.allEvents();

  // As a peer sees it: the same rows, re-hosted so they land in the REMOTE
  // fold, in a store of its own. A separate state dir is load-bearing — openStore
  // reads $MURMUR_STATE_DIR, so a replica opened without one is the same
  // database, and this read would just re-observe the local rows and their local
  // pid check.
  const asPeer = (events: Event[]): (string | null)[] => {
    const saved = process.env.MURMUR_STATE_DIR;
    process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-replica-"));
    const replica = openStore();
    try {
      replica.ingest(
        events.map((event) => ({
          ...event,
          host_id: "some-other-host",
          agent_id: `some-other-host:${event.pane}`,
        })),
      );
      return status(replica).agents.map((agent) => agent.state);
    } finally {
      replica.close();
      process.env.MURMUR_STATE_DIR = saved;
    }
  };
  expect(asPeer(raw)).toEqual(["working"]);

  await collect(store, noPeers);

  expect(asPeer(store.allEvents())).toEqual(["crashed"]);
});

test("synthesis is idempotent across collects", async () => {
  // Moving this onto `collect` is what makes idempotence matter. status()
  // collects and tmux re-runs the status bar on a tick, so this path now runs
  // constantly rather than once per peer fetch; a second crashed row per tick
  // would grow the log without bound.
  //
  // Mutation-tested, and it turned up something worth writing down: the two
  // guards in front of the append are each individually REDUNDANT. Deleting
  // `!newest.synthetic` alone keeps this green, and so does deleting
  // `newest.state === "working"` alone -- either one on its own stops the
  // second pass, because the newest row after the first pass is a synthetic
  // `crashed` and fails both. Only removing BOTH reproduces the runaway (3
  // collects -> 3 rows). Deliberately left as it is: two cheap guards that
  // each independently hold the invariant is a fine place to be, and this
  // comment is here so a future reader who deletes one and sees green does not
  // conclude it was dead code.
  store.ingest([working(1)]);

  await collect(store, noPeers);
  await collect(store, noPeers);
  await collect(store, noPeers);

  expect(store.allEvents().filter((event) => event.state === "crashed")).toHaveLength(1);
});

test("a live agent is left alone", async () => {
  // The guard that keeps this from being a liar: a `working` row whose pid IS
  // alive must stay working. Uses this test process's own pid, which is alive by
  // construction.
  store.ingest([working(1, { pid: process.pid })]);

  await collect(store, noPeers);

  expect(store.allEvents().filter((event) => event.state === "crashed")).toHaveLength(0);
  expect(status(store).agents.map((agent) => agent.state)).toEqual(["working"]);
});

test("another host's agents are not synthesized for", async () => {
  // Only the authoring node may author. A local pid check against a remote
  // agent's pid is meaningless — it names a process in another machine's table —
  // and a local row about a remote agent lands in the other fold and appears as
  // a SECOND agent with the same id.
  store.ingest([{ ...working(1), host_id: "remote-host", agent_id: "remote-host:%1" }]);

  await collect(store, noPeers);

  expect(store.allEvents().filter((event) => event.state === "crashed")).toHaveLength(0);
  expect(status(store).agents).toHaveLength(1);
});
