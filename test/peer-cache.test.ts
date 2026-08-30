import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { Channel } from "../src/channel.js";
import { collect, MAX_CONCURRENT_PEERS } from "../src/collector.js";
import { createIdentity } from "../src/identity.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { dbPath } from "../src/paths.js";
import { openStore, type Store } from "../src/store.js";
import type { Snapshot, SnapshotPane } from "../src/types.js";
import { paneViews, STALENESS_MS } from "../src/view.js";

/**
 * The peer cache: one opaque, validated document per peer, replaced whole or
 * not at all.
 *
 * `collector.test.ts` owns the fetch loop's reporting; `store.test.ts` owns the
 * two write statements. This file owns the edges where the two meet a READER --
 * the deadline, a peer that never answered, a stored document that no longer
 * parses, and what the view says about a node that went away. Each is a claim
 * that a reader holds no state of its own about a peer, so there is none for it
 * to hold wrongly and none for it to compensate with.
 */

const stores: Store[] = [];

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-peer-cache-"));
});

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // Already closed by the test.
    }
  }
});

function store(): Store {
  const opened = openStore();
  stores.push(opened);
  return opened;
}

function pane(id: string, over: Partial<SnapshotPane> = {}): SnapshotPane {
  return {
    pane: asPaneId(id),
    session: asSessionId("$0"),
    window: asWindowId("@0"),
    session_name: "remote-work",
    window_name: "worker-9",
    agent: {
      agent_id: `agent-${id}`,
      activity: "running",
      agent_name: "worker-9",
      pi_session: null,
      workstream: "murmur",
      role: null,
      cli: "pi",
      driver: "human",
      claimed_at: 1,
      updated_at: 500,
    },
    attention: [],
    ...over,
  };
}

function document(panes: SnapshotPane[], over: Partial<Snapshot> = {}): Snapshot {
  return {
    murmur_snapshot: 1,
    host_id: "REMOTE",
    display_name: "dev",
    murmur_version: "0.2.0",
    generated_at: 1_000,
    panes,
    ...over,
  };
}

const serve = (snapshot: Snapshot): Channel => ({ exec: async () => JSON.stringify(snapshot) });

test("the collect deadline leaves an unanswered peer's cache and fetched_at alone", async () => {
  // The deadline exists because the per-peer ssh timeout applies once per WAVE:
  // more peers than slots means the pool serialises the very timeouts it caps.
  // A peer the deadline cut off must be indistinguishable from any other host
  // that did not answer -- last-known document retained, `fetched_at` untouched
  // -- because "did not answer in time" is not evidence about its panes.
  const s = store();
  const names = Array.from({ length: MAX_CONCURRENT_PEERS + 1 }, (_, i) =>
    String(i).padStart(2, "0"),
  );
  for (const name of names) s.addPeer(name, name);
  const last = names[names.length - 1] as string;
  s.replacePeerSnapshot(last, { ok: true, at: 1_000, snapshot: document([pane("%1")]) });

  const hang: Channel = {
    exec: async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return JSON.stringify(document([pane("%2")]));
    },
  };
  const results = await collect(
    s,
    hang,
    9_000,
    new Promise<void>((resolve) => setTimeout(resolve, 20)),
  );

  const cut = results.find((result) => result.peer === last);
  expect(cut).toMatchObject({ ok: false, panes: 0 });
  expect(cut?.error).toContain("deadline");
  // Not classed unreachable: murmur never reached it, so it has said nothing
  // about itself either way, and a made-up verdict is worse than none.
  expect(cut?.unreachable).toBe(false);

  const peer = s.peers().find((entry) => entry.name === last);
  expect(peer?.snapshot?.panes.map((entry) => entry.pane)).toEqual(["%1"]);
  expect(peer).toMatchObject({ fetched_at: 1_000, last_attempt_at: 9_000 });
});

test("a peer that has never answered holds no snapshot and renders stale", async () => {
  // `addPeer` writes the two fields a human typed and nothing else, so there is
  // no cached document and no `fetched_at` to mistake for a fresh one. An
  // unreachable host you just added must not render as up to date.
  const identity = createIdentity("this-node");
  const s = store();
  s.addPeer("asleep", "asleep");

  const results = await collect(
    s,
    {
      exec: async () => {
        throw new Error("ssh: connect to host asleep port 22: Host is down");
      },
    },
    5_000,
  );

  expect(results[0]).toMatchObject({ ok: false, unreachable: true });
  expect(s.peers()[0]).toMatchObject({ snapshot: null, fetched_at: null, snapshot_at: null });
  // No document, no panes: a peer contributes rows only from what it served.
  expect(paneViews(s, identity, 5_000)).toEqual([]);
});

test("a stale node keeps its last-known panes verbatim, with no liveness inferred", async () => {
  // The whole reason a failed fetch retains the document. The reader has no pid
  // to probe and does not invent one: `activity` stays whatever that node last
  // said, and the only thing that changes is freshness -- a property of the
  // NODE, stated explicitly rather than folded into the pane's own state.
  const identity = createIdentity("this-node");
  const s = store();
  s.addPeer("dev", "dev");
  await collect(s, serve(document([pane("%7")])), 1_000);

  const fresh = paneViews(s, identity, 1_000);
  expect(fresh).toHaveLength(1);
  expect(fresh[0]).toMatchObject({ pane: "%7", activity: "running", freshness: "fresh" });

  await collect(
    s,
    {
      exec: async () => {
        throw new Error("ssh: connect to host dev port 22: Host is down");
      },
    },
    2_000,
  );

  const stale = paneViews(s, identity, 1_000 + STALENESS_MS + 1);
  expect(stale).toHaveLength(1);
  expect(stale[0]).toMatchObject({
    pane: "%7",
    // Byte-identical owner-reported facts: nothing about the pane was rewritten
    // to signal the host's silence.
    activity: "running",
    agent_id: "agent-%7",
    agent_name: "worker-9",
    workstream: "murmur",
    updated_at: 500,
    freshness: "stale",
    local: false,
  });
});

test("freshness is our clock and updated_at is theirs, and fetching does not merge them", async () => {
  // A peer polled one second ago can be serving a three-hour-old fact. Under one
  // clock that read as current, which is why the document's `generated_at` and
  // our `fetched_at` are stored in separate columns and only ours decides
  // freshness.
  const identity = createIdentity("this-node");
  const s = store();
  s.addPeer("dev", "dev");
  const threeHours = 3 * 3_600_000;
  const now = 100_000_000;
  const theirNews = now - threeHours;
  const served = pane("%3");
  const aged: SnapshotPane = {
    ...served,
    agent: served.agent === null ? null : { ...served.agent, updated_at: theirNews },
  };

  await collect(s, serve(document([aged], { generated_at: theirNews })), now);

  expect(s.peers()[0]).toMatchObject({ snapshot_at: theirNews, fetched_at: now });
  const view = paneViews(s, identity, now)[0];
  // The node is fresh -- we just reached it -- and its news is old. Both are
  // visible, and neither was computed from the other.
  expect(view).toMatchObject({
    freshness: "fresh",
    updated_at: theirNews,
    snapshot_at: theirNews,
    fetched_at: now,
  });
});

test("a cached peer document carries no owner_pid, so remote liveness is unrepresentable", async () => {
  // Asserted over the whole stored object graph rather than against the type: a
  // reader with a remote pid would eventually probe it, and a pid names a
  // process in another machine's table.
  const s = store();
  s.addPeer("dev", "dev");
  await collect(s, serve(document([pane("%1"), pane("%2")])), 1_000);

  const raw = new Database(dbPath(), { readonly: true });
  try {
    const stored = raw.prepare("SELECT snapshot FROM peers WHERE name = 'dev'").get() as {
      snapshot: string;
    };
    expect(stored.snapshot).not.toContain("owner_pid");
  } finally {
    raw.close();
  }
  expect(JSON.stringify(s.peers())).not.toContain("owner_pid");
});

test("a stored document that no longer parses reads as no snapshot and is left in place", () => {
  // A read path must not throw and must not delete: the peer's next successful
  // fetch replaces the column whole, and `last_error` describes the last FETCH,
  // not our own trouble reading what we already had.
  const s = store();
  s.addPeer("dev", "dev");
  s.replacePeerSnapshot("dev", { ok: true, at: 1_000, snapshot: document([pane("%1")]) });
  s.close();

  const raw = new Database(dbPath());
  try {
    raw.prepare("UPDATE peers SET snapshot = ? WHERE name = ?").run("{tru", "dev");
  } finally {
    raw.close();
  }

  const reopened = store();
  const peer = reopened.peers()[0];
  expect(peer).toMatchObject({ snapshot: null, fetched_at: 1_000, last_error: null });
  const raw2 = new Database(dbPath(), { readonly: true });
  try {
    // Still there, untouched: nothing on a read path deleted it.
    expect(raw2.prepare("SELECT snapshot FROM peers WHERE name = 'dev'").get()).toEqual({
      snapshot: "{tru",
    });
  } finally {
    raw2.close();
  }
});

test("removePeer takes the cached document with the row", async () => {
  // The peer cache is keyed by the operator's name and holds nothing else, so
  // removing a peer is the whole eviction story. Re-adding the same name starts
  // from no snapshot rather than resurrecting a document nobody asked for.
  const identity = createIdentity("this-node");
  const s = store();
  s.addPeer("dev", "dev");
  await collect(s, serve(document([pane("%1")])), 1_000);
  expect(paneViews(s, identity, 1_000)).toHaveLength(1);

  expect(s.removePeer("dev")).toBe(true);
  s.addPeer("dev", "dev");

  expect(s.peers()[0]).toMatchObject({ snapshot: null, fetched_at: null, last_error: null });
  expect(paneViews(s, identity, 1_000)).toEqual([]);
});

test("replacePeerSnapshot cannot create a peer, so no reader authors a remote host", () => {
  // Both statements are UPDATEs by name on purpose. A peer exists because an
  // operator typed a target; a snapshot arriving for an unknown name -- a peer
  // removed mid-collect, say -- must vanish rather than re-create the row.
  const s = store();

  s.replacePeerSnapshot("ghost", { ok: true, at: 1_000, snapshot: document([pane("%1")]) });
  s.replacePeerSnapshot("ghost", { ok: false, at: 2_000, error: "Host is down" });

  expect(s.peers()).toEqual([]);
});

test("peers are returned ordered by the name the operator typed", () => {
  const s = store();
  for (const name of ["pc", "air", "macmini"]) s.addPeer(name, name);
  expect(s.peers().map((peer) => peer.name)).toEqual(["air", "macmini", "pc"]);
});

test("the store exposes no reader-side mutation of remote state", () => {
  // The forbidden shapes, asserted as a closed key set rather than as prose. A
  // reader holds one snapshot per peer and evicts nothing: `forgetReplica`,
  // `forgetHost`, watermark rewind and `ingest` were all compensation for a
  // reader that could be wrong on its own, and re-adding any of them would put
  // that back.
  expect(Object.keys(store()).sort()).toEqual([
    "acknowledgePane",
    "addPeer",
    "buildLocalSnapshot",
    "claimAgent",
    "close",
    "localPanes",
    "peers",
    "reconcileLocal",
    "releaseAgent",
    "removePeer",
    "replacePeerSnapshot",
    "requestAttention",
    "setActivity",
  ]);
});
