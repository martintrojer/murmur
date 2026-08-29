import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { parseSshHosts } from "../src/cli/peer.js";
import { openStore } from "../src/store.js";

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

test("the same host cannot be added twice under different names", () => {
  // Found in use: `peer add bubba2 bubba` happily created a second peer for a
  // node already configured as `bubba`. Events dedupe on (host_id, seq) so the
  // agent list looked right, which is what made it easy to miss — meanwhile
  // every command paid two ssh round-trips to the same box.
  const store = openStore();
  store.upsertPeer({ name: "bubba", target: "bubba", host_id: "H", display_name: "bubba" });
  const clash = store
    .peers()
    .find((candidate) => candidate.host_id === "H" && candidate.name !== "bubba2");
  expect(clash?.name).toBe("bubba");
});

test("a peer keeps its identity when re-added under the same name", () => {
  const store = openStore();
  store.upsertPeer({ name: "bubba", target: "bubba", host_id: "H", display_name: "bubba" });
  store.upsertPeer({ name: "bubba", target: "bubba" });
  expect(store.peers()).toHaveLength(1);
  expect(store.peers()[0]?.host_id).toBe("H");
});
