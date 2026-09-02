import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { Channel } from "../src/channel.js";
import { collect } from "../src/collector.js";
import type { NodeIdentity } from "../src/identity.js";
import type { PaneId } from "../src/ids.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { openStore, type Store } from "../src/store.js";
import type { AgentMeta, Location } from "../src/types.js";
import type { PaneView } from "../src/view.js";
import { paneViews, renderState, STALENESS_MS, viewSort } from "../src/view.js";
import { fakeMux } from "./helpers/fake-mux.js";

/**
 * §11.19, the two-node smoke test, as a deterministic test.
 *
 * Two REAL stores in two state directories, joined by a channel that serialises
 * node B's `buildLocalSnapshot` exactly as `murmur export` prints it and hands
 * the string to node A's collector. That is the whole wire: the transport is ssh
 * and the payload is one JSON document, so a fake channel exercises everything
 * except the hop itself.
 *
 * Why this exists as well as a manual run. Every scenario below was verified
 * against a real second machine (Debian aarch64, over real ssh) while closing
 * `rewrite-integration`, and that run found two shipped defects. But a manual
 * run cannot be a regression test: the far node is not always reachable, and
 * three of these properties are exactly the ones no single-store test can see,
 * because they are about one node reading another's document.
 *
 * `peer-cache.test.ts` covers the cache's edges with hand-built documents. This
 * file differs by construction: node B's document is BUILT BY THE STORE, so a
 * build path that drifted from the validate path fails here rather than showing
 * up as "that host is broken" on every other machine.
 */

let dirA: string;
let dirB: string;
const stores: Store[] = [];

beforeEach(() => {
  dirA = mkdtempSync(join(tmpdir(), "murmur-node-a-"));
  dirB = mkdtempSync(join(tmpdir(), "murmur-node-b-"));
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

/**
 * A store in one node's state directory.
 *
 * `MURMUR_STATE_DIR` is repointed around the open because `dbPath()` is resolved
 * at open time; the handle then stays bound to that file, which is what lets two
 * nodes be open at once in one process.
 */
function nodeStore(dir: string): Store {
  const previous = process.env.MURMUR_STATE_DIR;
  process.env.MURMUR_STATE_DIR = dir;
  try {
    const opened = openStore();
    stores.push(opened);
    return opened;
  } finally {
    if (previous === undefined) delete process.env.MURMUR_STATE_DIR;
    else process.env.MURMUR_STATE_DIR = previous;
  }
}

const IDENTITY_A: NodeIdentity = { host_id: "HOST-A", display_name: "laptop" };
const IDENTITY_B: NodeIdentity = { host_id: "HOST-B", display_name: "bubba" };

function location(pane: string, window = "@1"): Location {
  return {
    session: asSessionId("$0"),
    window: asWindowId(window),
    pane: asPaneId(pane),
    session_name: "work",
    window_name: "api",
  };
}

function meta(over: Partial<AgentMeta> = {}): AgentMeta {
  return {
    agent_name: "worker-1",
    pi_session: null,
    workstream: "api",
    role: null,
    cli: "pi",
    driver: "orchestrated",
    ...over,
  };
}

function live(...panes: string[]): Set<PaneId> {
  return new Set(panes.map(asPaneId));
}

/**
 * The reconcile options every `collect` in this file must pass.
 *
 * `collect` ends by reconciling the LOCAL node against `mux.livePanes()`, and it
 * defaults to the real tmux. Not one call site here passed a mux, so 68 bare
 * `tmux list-panes -a` calls per suite run went to whichever server the
 * developer happened to have running -- and these tests then passed or failed on
 * ambient global state. Proven: with a shim returning no panes, "each node
 * authors only its own panes" fails (reconcile deletes the local agent), and it
 * passed here only because this machine's tmux happens to hold a `%1`. It would
 * fail on CI, for a reason that has nothing to do with what it asserts.
 *
 * `fakeMux` already defaults `livePanes` to an empty set, so the panes a test
 * claims locally have to be named -- which also makes the local half of each
 * two-node fixture explicit instead of inherited from the environment.
 */
function reconciling(...panes: string[]) {
  return { mux: fakeMux({ livePanes: () => live(...panes) }) };
}

/**
 * The single pane a node contributes, asserted to exist.
 *
 * `paneViews(...)[0]` is `PaneView | undefined`, and these tests care about the
 * word `renderState` produces for it. An explicit failure here says "the peer
 * contributed no pane", which is the real diagnosis, rather than a non-null
 * assertion the lint rules forbid or a `?.` that silently makes the assertion
 * vacuous.
 */
function onlyPane(views: PaneView[]): PaneView {
  expect(views).toHaveLength(1);
  const [view] = views;
  if (!view) throw new Error("expected exactly one pane in the view");
  return view;
}

/**
 * The wire. `murmur export` on node B, verbatim: build the document, serialise
 * it, hand back the string.
 *
 * `panes` and `isAlive` are node B's OWN local facts, which is the point --
 * node A never sees them and has no way to ask.
 */
function exportFrom(
  storeB: Store,
  world: { panes: Set<PaneId> | null; isAlive?: (pid: number) => boolean; now?: number },
): Channel {
  return {
    exec: async () => JSON.stringify(storeB.buildLocalSnapshot(IDENTITY_B, world)),
  };
}

/** A running agent on node B, owned by a pid only node B can probe. */
function runningAgentOnB(storeB: Store, pane: string, pid: number, over: Partial<AgentMeta> = {}) {
  const claim = storeB.claimAgent({
    location: location(pane),
    owner_pid: pid,
    meta: meta(over),
    now: 1_000,
    isAlive: () => true,
  });
  const agentId = "agent_id" in claim ? claim.agent_id : "";
  storeB.setActivity({
    agent_id: agentId,
    owner_pid: pid,
    activity: "running",
    location: location(pane),
    now: 1_000,
  });
  return agentId;
}

test("a remote RUNNING agent renders running on the other node, never crashed", async () => {
  // THE trap, and the one that looks exactly like a real crash. Node B's agent
  // is owned by pid 424242, which does not exist on node A. If any read path on
  // A probed a pid -- or if `owner_pid` were even present in the document -- A
  // would conclude the process is dead and paint `crashed` for a healthy agent
  // on another machine, with no way for the operator to tell it apart.
  const a = nodeStore(dirA);
  const b = nodeStore(dirB);
  runningAgentOnB(b, "%11", 424242);
  a.addPeer("bubba", "bubba");

  await collect(
    a,
    exportFrom(b, { panes: live("%11"), isAlive: () => true, now: 1_000 }),
    2_000,
    reconciling(),
  );

  const view = onlyPane(paneViews(a, IDENTITY_A, 2_000));
  expect(view).toMatchObject({
    pane: "%11",
    activity: "running",
    local: false,
    freshness: "fresh",
  });
  expect(renderState(view)).toBe("running");
  // Structurally, not by reading the type: the pid is absent from the whole
  // cached graph, so no future read path can start probing it.
  expect(JSON.stringify(a.peers())).not.toContain("owner_pid");
  expect(JSON.stringify(a.peers())).not.toContain("424242");
});

test("a node that goes quiet keeps its last-known panes and only loses freshness", async () => {
  // What an operator sees when a laptop sleeps: the agents that were there are
  // still listed, with the facts that node last reported, and the only thing
  // that changed is the warning that we have not heard from it. The alternative
  // -- emptying the view -- makes a sleeping node indistinguishable from an idle
  // one.
  const a = nodeStore(dirA);
  const b = nodeStore(dirB);
  runningAgentOnB(b, "%11", 424242);
  a.addPeer("bubba", "bubba");
  await collect(
    a,
    exportFrom(b, { panes: live("%11"), isAlive: () => true, now: 1_000 }),
    1_000,
    reconciling(),
  );

  const gone: Channel = {
    exec: async () => {
      throw new Error(
        "Command failed: ssh -o BatchMode=yes bubba murmur export\n" +
          "ssh: connect to host bubba port 22: Host is down\n",
      );
    },
  };
  const results = await collect(a, gone, 2_000, reconciling());

  expect(results[0]).toMatchObject({ peer: "bubba", ok: false, unreachable: true });
  const view = onlyPane(paneViews(a, IDENTITY_A, 1_000 + STALENESS_MS + 1));
  expect(view).toMatchObject({ pane: "%11", activity: "running", freshness: "stale" });
  // Freshness is a property of the NODE and stays in its own field: `stale` is
  // not a state, so it cannot displace what the agent was doing.
  expect(renderState(view)).toBe("running");
  // The document we already hold is not emptied by one failed tick.
  expect(a.peers()[0]?.snapshot?.panes).toHaveLength(1);
});

test("an owner replaced on one node replaces it on the other, leaving one row", async () => {
  // Node B's pane is taken over by a new process after the old one dies. The
  // document is complete, so A's cache is replaced whole: there is no merge
  // step that could leave both the old and the new agent listed for one pane,
  // which is what an incremental protocol has to get right and this one cannot
  // get wrong.
  const a = nodeStore(dirA);
  const b = nodeStore(dirB);
  const firstId = runningAgentOnB(b, "%11", 424242);
  a.addPeer("bubba", "bubba");
  await collect(
    a,
    exportFrom(b, { panes: live("%11"), isAlive: () => true, now: 1_000 }),
    1_000,
    reconciling(),
  );
  expect(paneViews(a, IDENTITY_A, 1_000)[0]?.agent_id).toBe(firstId);

  // A live second claimant is refused; only a DEAD owner is replaced.
  expect(
    b.claimAgent({
      location: location("%11"),
      owner_pid: 555_555,
      meta: meta({ agent_name: "intruder" }),
      isAlive: () => true,
    }),
  ).toMatchObject({ outcome: "refused", held_by_pid: 424242 });
  const replaced = b.claimAgent({
    location: location("%11"),
    owner_pid: 777_777,
    meta: meta({ agent_name: "worker-2" }),
    now: 3_000,
    isAlive: () => false,
  });
  expect(replaced.outcome).toBe("replaced");
  b.setActivity({
    agent_id: "agent_id" in replaced ? replaced.agent_id : "",
    owner_pid: 777_777,
    activity: "running",
    location: location("%11"),
    now: 3_000,
  });

  await collect(
    a,
    exportFrom(b, { panes: live("%11"), isAlive: () => true, now: 3_000 }),
    4_000,
    reconciling(),
  );

  const views = paneViews(a, IDENTITY_A, 4_000);
  expect(views).toHaveLength(1);
  expect(views[0]).toMatchObject({ pane: "%11", agent_name: "worker-2", activity: "running" });
  expect(views[0]?.agent_id).not.toBe(firstId);
});

test("attention raised on one node is visible on the other, and acknowledging it there clears it here", async () => {
  // Attention is addressed by pane and carries its own location, so an
  // attention-only pane -- a codex window with no murmur agent in it -- crosses
  // the wire as a listable row. And because absence from a successful snapshot
  // IS absence, acknowledging it on B removes it from A with no tombstone.
  const a = nodeStore(dirA);
  const b = nodeStore(dirB);
  runningAgentOnB(b, "%11", 424242);
  b.requestAttention({
    kind: "blocked",
    location: location("%12", "@2"),
    message: "needs a decision",
    source: "codex",
    now: 1_500,
  });
  a.addPeer("bubba", "bubba");
  const world = { panes: live("%11", "%12"), isAlive: () => true, now: 2_000 };

  await collect(a, exportFrom(b, world), 2_000, reconciling());

  const before = viewSort(paneViews(a, IDENTITY_A, 2_000));
  // Attention sorts ahead of a merely running agent, so the row that wants a
  // human is the first one an operator sees.
  expect(before.map((view) => view.pane)).toEqual(["%12", "%11"]);
  expect(before[0]).toMatchObject({ pane: "%12", activity: null, attention: ["blocked"] });

  expect(b.acknowledgePane(asPaneId("%12"))).toBe(1);
  // Acknowledge the pane that DOES hold a running agent too. This is the
  // measured incident's shape, across the wire: focus must clear attention and
  // leave the run alone, so a pane with nothing to acknowledge is a no-op rather
  // than a state change. Asserted here because acknowledging %12 alone could not
  // catch it -- %12 has no agent row for a bad acknowledge to damage.
  expect(b.acknowledgePane(asPaneId("%11"))).toBe(0);
  await collect(a, exportFrom(b, { ...world, now: 3_000 }), 3_000, reconciling());

  const after = paneViews(a, IDENTITY_A, 3_000);
  expect(after.map((view) => view.pane)).toEqual(["%11"]);
  // Still running, on the far node's own word, after two acknowledgements.
  expect(after[0]).toMatchObject({ activity: "running", attention: [] });
});

test("a crash detected on one node reaches the other as crashed, with the dead agent still named", async () => {
  // Node B notices its own owner died -- the only node that can, since it is the
  // only one with the pid -- and records it. What crosses the wire is the
  // CONCLUSION, not the evidence, and it must still say WHICH agent died: an
  // operator seeing `crashed` with no name cannot act on it.
  const a = nodeStore(dirA);
  const b = nodeStore(dirB);
  runningAgentOnB(b, "%11", 424242, { agent_name: "worker-7", workstream: "api" });
  a.addPeer("bubba", "bubba");

  // The pane is still live; the process in it is not.
  const summary = b.reconcileLocal({ panes: live("%11"), isAlive: () => false, now: 5_000 });
  expect(summary.crashed).toEqual(["%11"]);
  await collect(
    a,
    exportFrom(b, { panes: live("%11"), isAlive: () => false, now: 5_000 }),
    5_000,
    reconciling(),
  );

  const view = onlyPane(paneViews(a, IDENTITY_A, 5_000));
  expect(view).toMatchObject({
    pane: "%11",
    activity: "stopped",
    attention: ["crashed"],
    // The identity of the agent that died survives the crash that killed it.
    agent_name: "worker-7",
    workstream: "api",
  });
  expect(renderState(view)).toBe("crashed");
});

test("a node whose tmux cannot answer publishes its last-known panes rather than an empty document", async () => {
  // `panes: null` is absence of evidence. If it reaped, a tmux hiccup on B would
  // delete every agent on B and -- because a successful snapshot is
  // authoritative -- that deletion would propagate to A as fact.
  const a = nodeStore(dirA);
  const b = nodeStore(dirB);
  runningAgentOnB(b, "%11", 424242);
  a.addPeer("bubba", "bubba");

  await collect(
    a,
    exportFrom(b, { panes: null, isAlive: () => false, now: 2_000 }),
    2_000,
    reconciling(),
  );

  const views = paneViews(a, IDENTITY_A, 2_000);
  expect(views).toHaveLength(1);
  expect(views[0]).toMatchObject({ pane: "%11", activity: "running" });
});

test("a peer serving a document this version cannot read is broken, not absent", async () => {
  // The cross-VERSION case, and a real one: the second node used to run a build
  // that answered `murmur export` with `error: required option '--since <seq>'
  // not specified`. That must read as a pairing problem an operator can fix, and
  // it must not discard what we already had.
  const a = nodeStore(dirA);
  const b = nodeStore(dirB);
  runningAgentOnB(b, "%11", 424242);
  a.addPeer("bubba", "bubba");
  await collect(
    a,
    exportFrom(b, { panes: live("%11"), isAlive: () => true, now: 1_000 }),
    1_000,
    reconciling(),
  );

  const oldBuild: Channel = {
    exec: async () => {
      throw new Error(
        "Command failed: ssh -o BatchMode=yes bubba murmur export\n" +
          "error: required option '--since <seq>' not specified\n",
      );
    },
  };
  const results = await collect(a, oldBuild, 2_000, reconciling());

  // Reachable: the host answered. It answered wrongly, which is actionable.
  expect(results[0]).toMatchObject({ peer: "bubba", ok: false, unreachable: false });
  const peer = a.peers()[0];
  expect(peer?.last_error).toBe("error: required option '--since <seq>' not specified");
  // The last good document stands, and our clock for it is untouched.
  expect(peer?.snapshot?.panes).toHaveLength(1);
  expect(peer).toMatchObject({ fetched_at: 1_000, last_attempt_at: 2_000 });
});

test("two nodes' clocks stay separate: a freshly fetched old fact is fresh and old at once", async () => {
  // The two-clock property, end to end across two real stores. Node B's document
  // was generated hours ago; we reached it a second ago. One number cannot say
  // both, and conflating them makes stale work look current.
  const a = nodeStore(dirA);
  const b = nodeStore(dirB);
  const threeHoursAgo = 100_000_000 - 3 * 3_600_000;
  runningAgentOnB(b, "%11", 424242);
  a.addPeer("bubba", "bubba");

  await collect(
    a,
    exportFrom(b, { panes: live("%11"), isAlive: () => true, now: threeHoursAgo }),
    100_000_000,
    reconciling(),
  );

  const [view] = paneViews(a, IDENTITY_A, 100_000_000);
  expect(view?.freshness).toBe("fresh");
  expect(view?.snapshot_at).toBe(threeHoursAgo);
  expect(view?.fetched_at).toBe(100_000_000);
  expect(a.peers()[0]).toMatchObject({ snapshot_at: threeHoursAgo, fetched_at: 100_000_000 });
});

test("each node authors only its own panes, so identically-numbered panes do not collide", async () => {
  // Both machines routinely hold `%1`: pane ids are unique per NODE, never
  // globally. The view must keep them apart by host, or one node's agent
  // silently shadows the other's -- and every surface that resolves a selection
  // (jump, preview) would act on the wrong machine.
  const a = nodeStore(dirA);
  const b = nodeStore(dirB);
  a.claimAgent({
    location: location("%1"),
    owner_pid: process.pid,
    meta: meta({ agent_name: "local-worker" }),
    now: 1_000,
    isAlive: () => true,
  });
  runningAgentOnB(b, "%1", 424242, { agent_name: "remote-worker" });
  a.addPeer("bubba", "bubba");

  await collect(
    a,
    exportFrom(b, { panes: live("%1"), isAlive: () => true, now: 1_000 }),
    1_000,
    // A holds %1 locally too -- that collision is the point of this test.
    reconciling("%1"),
  );

  const views = paneViews(a, IDENTITY_A, 1_000);
  expect(views).toHaveLength(2);
  const byHost = new Map(views.map((view) => [view.host_id, view]));
  expect(byHost.get("HOST-A")).toMatchObject({
    pane: "%1",
    agent_name: "local-worker",
    local: true,
  });
  expect(byHost.get("HOST-B")).toMatchObject({
    pane: "%1",
    agent_name: "remote-worker",
    local: false,
  });
});
