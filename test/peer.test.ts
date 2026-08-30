import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { formatTable, lastSeen, parseSshHosts, peerAddDecision } from "../src/cli/peer.js";
import { openStore } from "../src/store.js";
import type { Peer } from "../src/types.js";

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
  store.upsertPeer({ name: "ghost", target: "192.0.2.1" });
  expect(store.peers()).toHaveLength(1);
  expect(store.removePeer("ghost")).toBe(true);
  expect(store.peers()).toEqual([]);
  expect(store.removePeer("ghost")).toBe(false);
});

test("peer add refuses a host already configured under another name", () => {
  // Found in use: `peer add bubba2 bubba` happily created a second peer for a
  // node already configured as `bubba`. Events dedupe on (host_id, seq) so the
  // agent list looked right, which is what made it easy to miss - meanwhile
  // every command paid two ssh round-trips to the same box.
  //
  // The old version of this test inserted one peer and then reimplemented the
  // duplicate lookup in its own assertion, so it never ran the production
  // branch: disabling that branch entirely left it green.
  const envelope = {
    schema_version: 1,
    host_id: "H",
    display_name: "bubba",
    exported_at: 1,
  };
  const peers = [{ name: "bubba", target: "bubba", host_id: "H", display_name: "bubba" } as Peer];

  const refusal = peerAddDecision({
    name: "bubba2",
    target: "bubba",
    envelope,
    selfHostId: "SELF",
    peers,
  });

  expect(refusal).toContain('already configured as peer "bubba"');
});

test("re-adding the same peer name is allowed, so a target can be corrected", () => {
  const refusal = peerAddDecision({
    name: "bubba",
    target: "bubba.local",
    envelope: { schema_version: 1, host_id: "H", display_name: "bubba", exported_at: 1 },
    selfHostId: "SELF",
    peers: [{ name: "bubba", target: "bubba", host_id: "H", display_name: "bubba" } as Peer],
  });

  expect(refusal).toBeNull();
});

test("peer add refuses this node itself", () => {
  const refusal = peerAddDecision({
    name: "me",
    target: "localhost",
    envelope: { schema_version: 1, host_id: "SELF", display_name: "me", exported_at: 1 },
    selfHostId: "SELF",
    peers: [],
  });

  expect(refusal).toContain("is this node");
});

test("an unreachable host is still added, on the operator's word", () => {
  // No envelope means the probe failed. The peer is added anyway and the first
  // successful collect discovers who it is.
  const refusal = peerAddDecision({
    name: "asleep",
    target: "asleep",
    envelope: null,
    selfHostId: "SELF",
    peers: [],
  });

  expect(refusal).toBeNull();
});

test("a peer keeps its identity when re-added under the same name", () => {
  const store = openStore();
  store.upsertPeer({ name: "bubba", target: "bubba", host_id: "H", display_name: "bubba" });
  store.upsertPeer({ name: "bubba", target: "bubba" });
  expect(store.peers()).toHaveLength(1);
  expect(store.peers()[0]?.host_id).toBe("H");
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
