import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import type { Channel } from "../src/channel.js";
import { SNAPSHOT_VERSION, versionCell } from "../src/cli/peer.js";
import { collect } from "../src/collector.js";
import { createIdentity } from "../src/identity.js";
import { VERSION } from "../src/index.js";
import { openStore } from "../src/store.js";
import type { PeerRecord, Snapshot } from "../src/types.js";
import { runBuiltCli } from "./helpers/built.js";

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-peerver-"));
});

function cell(over: Partial<Pick<PeerRecord, "murmur_version" | "snapshot_version">>) {
  return versionCell({ murmur_version: null, snapshot_version: null, ...over }, SNAPSHOT_VERSION);
}

/** A document, as a peer's `murmur export` would print it. */
function wire(over: Partial<Snapshot> = {}): string {
  return JSON.stringify({
    murmur_snapshot: 1,
    host_id: "REMOTE",
    display_name: "bubba",
    murmur_version: "0.1.4",
    generated_at: 1,
    panes: [],
    ...over,
  });
}

test("this node's own snapshot states its version and speaks snapshot 1", () => {
  const identity = createIdentity("here");
  const store = openStore();
  const snapshot = store.buildLocalSnapshot(identity, { panes: new Set() });
  store.close();

  // A real semver, and the SAME one the SDK advertises. Two readers of
  // package.json (index.ts for the SDK, store.ts for the document) must not be
  // able to disagree about what this node is.
  expect(snapshot.murmur_version).toMatch(/^\d+\.\d+\.\d+/);
  expect(snapshot.murmur_version).toBe(VERSION);
  // A literal, not the constant. Comparing the document against the constant
  // passes whatever the constant is, so it cannot notice a bump at all.
  expect(snapshot.murmur_snapshot).toBe(1);
  expect(SNAPSHOT_VERSION).toBe(1);
});

test("a collect records what the peer is running, out of the document itself", async () => {
  // The cache cannot disagree with the snapshot it holds, because every derived
  // field is read from the same document rather than passed alongside it.
  const store = openStore();
  store.addPeer("bubba", "bubba");

  await collect(store, { exec: async () => wire() }, 5_000);

  expect(store.peers()[0]).toMatchObject({
    murmur_version: "0.1.4",
    snapshot_version: 1,
    host_id: "REMOTE",
    display_name: "bubba",
  });
  store.close();
});

test("a peer speaking a newer snapshot version is refused and recorded as broken", async () => {
  // Forward compatibility is not offered: a higher version is rejected too,
  // because a reader that guesses at a newer document's meaning is worse than
  // one that says the pairing is wrong. And the refusal must be VISIBLE -- under
  // the old model the parse threw before the peer row was written, so `peer list`
  // could show a version for every peer except the incompatible one.
  const store = openStore();
  store.addPeer("newer", "newer");
  const channel: Channel = {
    exec: async () => wire({ murmur_snapshot: 2 as never, murmur_version: "9.9.9" }),
  };

  const results = await collect(store, channel, 5_000);

  expect(results[0]).toMatchObject({ ok: false, unreachable: false });
  const peer = store.peers()[0];
  expect(peer?.last_error).toContain("murmur_snapshot");
  // Not credited with a successful sync: nothing valid was parsed, so
  // fetched_at stays null and the peer renders "never" rather than fresh.
  expect(peer?.fetched_at).toBeNull();
  expect(peer?.snapshot).toBeNull();
  store.close();
});

test("a never-collected peer is unknown and is NOT a mismatch", () => {
  // A down or asleep peer is the common case in this tool, not an exception.
  // Absence of information is not evidence of incompatibility, and flagging it
  // would make the mark meaningless on a normal fleet.
  expect(cell({})).toEqual({ text: "unknown", incompatible: false });
});

test("only a snapshot-version mismatch is flagged; a murmur version is shown plainly", () => {
  // Drawn from what the code enforces. `parseSnapshot` rejects any
  // `murmur_snapshot` other than 1, so state genuinely does not flow -- a
  // behavioural fact, and the only thing marked.
  //
  // A differing murmur version is not. Two nodes on snapshot 1 running 0.1.3 and
  // 0.2.0 interoperate, so marking it would fire on every patch release and
  // train the operator to ignore the column.
  expect(cell({ murmur_version: "0.1.3", snapshot_version: 1 })).toEqual({
    text: "0.1.3",
    incompatible: false,
  });
  expect(cell({ murmur_version: "0.9.0", snapshot_version: 1 })).toEqual({
    text: "0.9.0",
    incompatible: false,
  });

  const newer = cell({ murmur_version: "9.9.9", snapshot_version: 9 });
  expect(newer.incompatible).toBe(true);
  expect(newer.text).toContain("9.9.9");
  expect(newer.text).toContain("snapshot 9");

  // Answered, but from a build too old to say what it is. Distinct from never
  // having answered: this one is reachable and talking.
  expect(cell({ snapshot_version: 1 })).toEqual({ text: "unreported", incompatible: false });

  // The number appears ONLY when it is the problem, or every row would read
  // "0.1.4 (snapshot 1)" and the signal would be lost in the noise.
  expect(cell({ murmur_version: "0.1.4", snapshot_version: 1 }).text).not.toContain("snapshot");
});

/**
 * Run the real CLI against a scratch state dir, so the table is the shipped one.
 *
 * `runBuiltCli` rather than a bare execFileSync: this test executes dist/, so a
 * stale build silently tests the PREVIOUS version of the table. That is exactly
 * how this test once passed in one checkout and failed in another on identical
 * source.
 */
function cli(stateDir: string, ...args: string[]): string {
  return runBuiltCli(args, { ...process.env, MURMUR_STATE_DIR: stateDir });
}

test("peer list stays exactly as narrow as today when nothing has been collected", () => {
  // `peer list` must stay useful with ZERO successful collects, because a down
  // or asleep peer is the common case in this tool. So the VERSION column
  // follows the same rule the PEER column already uses: it appears only when
  // some row can answer it.
  const dir = process.env.MURMUR_STATE_DIR as string;
  const store = openStore();
  store.addPeer("asleep", "asleep");
  store.close();

  const out = cli(dir, "peer", "list");

  expect(out).toContain("asleep");
  expect(out).toContain("never");
  expect(out).not.toContain("VERSION");
  // And no scary language on a peer that is merely quiet.
  expect(out).not.toContain("incompatible");
});

test("peer list shows a VERSION column once a peer has reported, and names a real mismatch", () => {
  const dir = process.env.MURMUR_STATE_DIR as string;
  const store = openStore();
  store.addPeer("matched", "matched");
  store.replacePeerSnapshot("matched", {
    ok: true,
    at: Date.now(),
    snapshot: {
      murmur_snapshot: 1,
      host_id: "M",
      display_name: "macmini",
      murmur_version: "0.1.4",
      generated_at: Date.now(),
      panes: [],
    },
  });
  store.close();

  const out = cli(dir, "peer", "list");

  expect(out).toContain("VERSION");
  expect(out).toContain("0.1.4");
  expect(out).toContain("macmini");
  // A matched pairing says nothing about versions beyond the number itself.
  expect(out).not.toContain("incompatible");
  expect(out.split("\n").find((line) => line.includes("matched"))).not.toContain("snapshot");
});

test("peer list names a peer that answered with something broken", () => {
  // Reachable but broken is the failure an operator can act on, and it used to
  // be indistinguishable from a sleeping laptop in this table.
  const dir = process.env.MURMUR_STATE_DIR as string;
  const store = openStore();
  store.addPeer("broken", "broken");
  store.replacePeerSnapshot("broken", {
    ok: false,
    at: Date.now(),
    error: "murmur_snapshot: expected 1, got 2",
  });
  store.close();

  const out = cli(dir, "peer", "list");

  expect(out).toContain("broken");
  expect(out).toContain("last attempt failed");
  expect(out).toContain("murmur_snapshot");
});
