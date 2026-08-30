import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { formatTable, lastSeen, parseSshHosts, peerAddDecision } from "../src/cli/peer.js";
import { openStore } from "../src/store.js";
import type { PeerRecord, Snapshot } from "../src/types.js";

/** A probe result: what `peer add` parsed out of the far side's `murmur export`. */
function probe(hostId: string, displayName: string): Snapshot {
  return {
    murmur_snapshot: 1,
    host_id: hostId,
    display_name: displayName,
    murmur_version: "0.2.0",
    generated_at: 1,
    panes: [],
  };
}

function existing(name: string, hostId: string): PeerRecord {
  return {
    name,
    target: name,
    host_id: hostId,
    display_name: name,
    snapshot: null,
    snapshot_at: null,
    fetched_at: null,
    last_attempt_at: null,
    last_error: null,
    murmur_version: null,
    snapshot_version: null,
  };
}

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-peer-"));
});

test("parses literal Host names and skips wildcards and Match blocks", () => {
  const config = `
# named hosts
  Host dev *.corp
    HostName dev.example.com
MATCH host dev
    User ignored
    IdentityFile ~/.ssh/ignored
\tHost a b
    User person
Host ?ingle exact
Host final # trailing comment
`;

  expect(parseSshHosts(config)).toEqual(["dev", "a", "b", "exact", "final"]);
});

test("removePeer drops the peer and reports whether it existed", () => {
  const store = openStore();
  store.addPeer("ghost", "192.0.2.1");
  expect(store.peers()).toHaveLength(1);
  expect(store.removePeer("ghost")).toBe(true);
  expect(store.peers()).toEqual([]);
  expect(store.removePeer("ghost")).toBe(false);
});

test("peer add refuses a host already configured under another name", () => {
  // Found in use: `peer add bubba2 bubba` happily created a second peer for a
  // node already configured as `bubba`. Both peers serve the same host's
  // snapshot, so the agent list looked right and every command quietly paid two
  // ssh round-trips to the same box.
  //
  // Nothing dedupes for you any more either. Under the event model two names for
  // one node merely doubled the ssh traffic; now each name holds its own cached
  // snapshot of the same machine, so every pane on it is listed twice.
  const refusal = peerAddDecision({
    name: "bubba2",
    target: "bubba",
    snapshot: probe("H", "bubba"),
    selfHostId: "SELF",
    peers: [existing("bubba", "H")],
  });

  expect(refusal).toContain('already configured as peer "bubba"');
});

test("re-adding the same peer name is allowed, so a target can be corrected", () => {
  const refusal = peerAddDecision({
    name: "bubba",
    target: "bubba.local",
    snapshot: probe("H", "bubba"),
    selfHostId: "SELF",
    peers: [existing("bubba", "H")],
  });

  expect(refusal).toBeNull();
});

test("peer add refuses this node itself", () => {
  const refusal = peerAddDecision({
    name: "me",
    target: "localhost",
    snapshot: probe("SELF", "me"),
    selfHostId: "SELF",
    peers: [],
  });

  expect(refusal).toContain("is this node");
});

test("an unreachable host is still added, on the operator's word", () => {
  // No snapshot means the probe failed. The peer is added anyway and the first
  // successful collect discovers who it is.
  const refusal = peerAddDecision({
    name: "asleep",
    target: "asleep",
    snapshot: null,
    selfHostId: "SELF",
    peers: [],
  });

  expect(refusal).toBeNull();
});

test("a peer keeps its cache when its target is corrected", () => {
  // Re-adding is how a target gets fixed, so it must update the one field the
  // operator retyped and nothing else. Discarding the snapshot here would blank
  // the host's whole pane list until the next collect.
  const store = openStore();
  store.addPeer("bubba", "bubba");
  store.replacePeerSnapshot("bubba", { ok: true, at: 1_000, snapshot: probe("H", "bubba") });

  store.addPeer("bubba", "bubba.local");

  expect(store.peers()).toHaveLength(1);
  expect(store.peers()[0]).toMatchObject({
    target: "bubba.local",
    host_id: "H",
    fetched_at: 1_000,
  });
});

test("peer list output is column-aligned under a header", () => {
  const table = formatTable([
    ["NAME", "TARGET", "HOST"],
    ["macmini", "macmini", "Martins-Mac-mini.local"],
    ["pc", "linuxpc", "18c04d69b860"],
  ]);
  expect(table).toBe(
    [
      "NAME     TARGET   HOST",
      "macmini  macmini  Martins-Mac-mini.local",
      "pc       linuxpc  18c04d69b860",
      "",
    ].join("\n"),
  );
});

test("lastSeen separates never-answered from merely stale", () => {
  // These mean different things and used to render identically. A peer that has
  // never answered is a setup problem -- wrong target, or murmur not installed
  // on it -- and no amount of waiting fixes it. An old age is an ordinary
  // sleeping node, which is the normal state of a fleet.
  const now = 1_000_000_000;
  expect(lastSeen(null, now)).toBe("never");
  expect(lastSeen(now - 1_000, now)).toBe("just now");
  expect(lastSeen(now - 12 * 3_600_000, now)).toBe("12h ago");
  expect(lastSeen(now - 3 * 86_400_000, now)).toBe("3d ago");
});
