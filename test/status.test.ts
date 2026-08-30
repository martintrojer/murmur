import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Channel } from "../src/channel.js";
import { ssh } from "../src/channel.js";
import type { NodeIdentity } from "../src/identity.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { status, statusWithCollect, tmuxStatus } from "../src/status.js";
import { openStore, type Store } from "../src/store.js";
import type {
  AgentMeta,
  AttentionKind,
  Driver,
  Location,
  Snapshot,
  SnapshotPane,
} from "../src/types.js";
import { STALENESS_MS } from "../src/view.js";

const stores: Store[] = [];
let store: Store;

const IDENTITY: NodeIdentity = { host_id: "LOCAL", display_name: "here" };

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-status-"));
  store = openStore();
  stores.push(store);
  // Never a real ssh from a unit test: a hung exec is the honest default,
  // because every caller of statusWithCollect must survive one.
  vi.spyOn(ssh, "exec").mockImplementation(async () => await new Promise<string>(() => {}));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const opened of stores.splice(0)) opened.close();
});

function location(pane: string): Location {
  return {
    session: asSessionId("$0"),
    window: asWindowId(`@${pane.slice(1)}`),
    pane: asPaneId(pane),
    session_name: "work",
    window_name: pane,
  };
}

function meta(over: Partial<AgentMeta> = {}): AgentMeta {
  return {
    agent_name: null,
    pi_session: null,
    workstream: "murmur",
    role: null,
    cli: "pi",
    driver: "human",
    ...over,
  };
}

/** A local pane with an agent, optionally running, optionally wanting attention. */
function localAgent(
  pane: string,
  options: {
    activity?: "running" | "stopped";
    driver?: Driver;
    attention?: AttentionKind[];
  } = {},
): void {
  const claim = store.claimAgent({
    location: location(pane),
    owner_pid: process.pid,
    meta: meta({ driver: options.driver ?? "human" }),
  });
  if (options.activity === "running") {
    store.setActivity({
      agent_id: "agent_id" in claim ? claim.agent_id : "",
      owner_pid: process.pid,
      activity: "running",
      location: location(pane),
    });
  }
  for (const kind of options.attention ?? []) {
    store.requestAttention({ kind, location: location(pane), message: "", source: "pi" });
  }
}

function remoteSnapshot(panes: SnapshotPane[], generatedAt = 1_000): Snapshot {
  return {
    murmur_snapshot: 1,
    host_id: "REMOTE",
    display_name: "container-id-nobody-can-type",
    murmur_version: "0.2.0",
    generated_at: generatedAt,
    panes,
  };
}

/** A remote pane whose agent last said something at `updatedAt`. */
function remoteAgentPane(pane: string, updatedAt: number): SnapshotPane {
  const base = remotePane(pane);
  return {
    ...base,
    agent: base.agent === null ? null : { ...base.agent, updated_at: updatedAt },
  };
}

function remotePane(pane: string, over: Partial<SnapshotPane> = {}): SnapshotPane {
  return {
    pane: asPaneId(pane),
    session: asSessionId("$9"),
    window: asWindowId("@9"),
    session_name: "far",
    window_name: pane,
    agent: {
      agent_id: `agent-${pane}`,
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
    ...over,
  };
}

test("counts group by render state, and attention beats activity", () => {
  localAgent("%1", { activity: "running" });
  localAgent("%2", { activity: "running", attention: ["blocked"] });
  localAgent("%3", { attention: ["crashed"] });
  localAgent("%4", { attention: ["done"] });
  localAgent("%5");

  const result = status(store, IDENTITY);

  expect(result.counts).toEqual({ crashed: 1, blocked: 1, done: 1, running: 1, idle: 1 });
  // Both facts survive on the row that carries both, which is the point of
  // keeping them separate: a running agent CAN be waiting on a human.
  const blocked = result.panes.find((pane) => pane.pane === "%2");
  expect(blocked).toMatchObject({ activity: "running", attention: ["blocked"] });
});

test("a remote pane keeps its own node's fields and takes its node's freshness", () => {
  store.addPeer("dev", "dev.example");
  store.replacePeerSnapshot("dev", {
    ok: true,
    at: 1_000,
    snapshot: remoteSnapshot([remotePane("%50")]),
  });

  const result = status(store, IDENTITY, 121_001);

  const remote = result.panes.find((pane) => pane.pane === "%50");
  expect(remote).toMatchObject({
    host_id: "REMOTE",
    // The configured peer name, not the machine's self-reported display_name:
    // that can be a container id nobody can type back at `peer remove`.
    host: "dev",
    local: false,
    activity: "running",
    // Freshness is a property of the NODE and never of an agent, and a stale
    // node keeps its last-known fields verbatim rather than being reinterpreted.
    freshness: "stale",
  });
  expect(result.counts.running).toBe(1);
});

test("local panes are always fresh, and no read path probes a pid", () => {
  // A local pane is authored by this node, so there is nothing to be stale
  // about. Freshness answers "how recently did we reach the node that told us",
  // and for our own panes the answer is always "now".
  localAgent("%1", { activity: "running" });

  const result = status(store, IDENTITY, Date.now() + 86_400_000);

  expect(result.panes[0]).toMatchObject({ local: true, freshness: "fresh", host: "here" });
  // The whole returned graph, structurally: no pid crosses into a view, so
  // remote liveness inference is unrepresentable rather than merely avoided.
  expect(JSON.stringify(result)).not.toContain("owner_pid");
  expect(JSON.stringify(result)).not.toContain(String(process.pid));
});

test("an attention-only pane is a listable row with no agent", () => {
  // The codex case: a harness murmur never instrumented, whose only trace is a
  // notification. It has no agent row, and it must still be visible and
  // jumpable -- which is why `attention` carries its own location.
  store.requestAttention({
    kind: "blocked",
    location: location("%7"),
    message: "needs input",
    source: "codex",
  });

  const result = status(store, IDENTITY);

  expect(result.panes).toHaveLength(1);
  expect(result.panes[0]).toMatchObject({
    pane: "%7",
    activity: null,
    agent_id: null,
    attention: ["blocked"],
    // No agent row means no reported driver, and `human` is the answer that
    // keeps the row visible in the picker.
    driver: "human",
  });
  expect(result.counts.blocked).toBe(1);
});

test("human and orchestrated panes are counted separately but both listed", () => {
  localAgent("%1", { attention: ["blocked"] });
  localAgent("%2", { activity: "running", driver: "orchestrated" });
  localAgent("%3", { activity: "running", driver: "orchestrated" });

  const result = status(store, IDENTITY);

  expect(result.counts.blocked).toBe(1);
  expect(result.counts.running).toBe(0);
  expect(result.orchestrated_counts.running).toBe(2);
  expect(result.panes).toHaveLength(3);
});

test("tmux status emits urgent counts and never agent-supplied text", () => {
  const injection = "#(touch /tmp/pwned)";
  localAgent("%1", { attention: ["crashed"] });
  localAgent("%2", { attention: ["blocked"] });
  localAgent("%3", { attention: ["done"] });
  localAgent("%4", { activity: "running" });
  localAgent("%5");
  store.requestAttention({
    kind: "crashed",
    location: location("%6"),
    message: injection,
    source: injection,
  });
  store.addPeer(injection, injection);

  const output = tmuxStatus(status(store, IDENTITY));

  expect(output).toBe("crashed\t2\nblocked\t1\ndone\t1\nworking\t1\nidle\t1\n");
  expect(output).not.toContain(injection);
});

test("a crew agent that needs a human is counted, one that does not is not", () => {
  // The distinction `driver` exists for, applied per state rather than
  // wholesale. A supervisor consumes a `done` worker's result and nobody has to
  // acknowledge it; a `running` worker asks for nothing. But an orchestrator
  // cannot answer a question meant for a human, and it may never retry a worker
  // that died.
  localAgent("%1", { driver: "orchestrated", attention: ["blocked"] });
  localAgent("%2", { driver: "orchestrated", attention: ["crashed"] });
  localAgent("%3", { driver: "orchestrated", attention: ["done"] });
  localAgent("%4", { driver: "orchestrated", activity: "running" });

  expect(tmuxStatus(status(store, IDENTITY))).toBe("crashed\t1\nblocked\t1\n");
});

test("tmux status omits a crew-only fleet that wants nothing", () => {
  localAgent("%1", { driver: "orchestrated", activity: "running" });

  expect(tmuxStatus(status(store, IDENTITY))).toBe("");
});

test("status works with no peers configured", () => {
  localAgent("%1", { activity: "running" });

  const result = status(store, IDENTITY);

  expect(result.peers).toEqual([]);
  expect(result.counts.running).toBe(1);
  expect(result.panes[0]).toMatchObject({ local: true, fetched_at: null, snapshot_at: null });
});

test("a peer that has never been reached is stale, not fresh", () => {
  // Null `fetched_at` on a PEER means the first collect has not succeeded, which
  // is the opposite of the answer that reads well for a local pane. Found live:
  // an unreachable host added with `peer add` rendered as up to date.
  store.addPeer("ghost", "192.0.2.1");

  const view = status(store, IDENTITY);

  expect(view.peers[0]).toMatchObject({ fetched_at: null, stale: true });
});

test("a peer's staleness is the view's freshness verdict, not a second threshold", () => {
  // One definition of "how long is too long", used by the peer list and by every
  // pane that peer contributes. Two copies of the number is how a peer could
  // read stale in `peer list` while its panes rendered fresh in the picker -- a
  // disagreement no operator can resolve from the output.
  const at = 1_000;
  store.addPeer("dev", "dev");
  store.replacePeerSnapshot("dev", { ok: true, at, snapshot: remoteSnapshot([remotePane("%50")]) });

  const edge = status(store, IDENTITY, at + STALENESS_MS);
  expect(edge.peers[0]?.stale).toBe(false);
  expect(edge.panes.find((pane) => pane.pane === "%50")?.freshness).toBe("fresh");

  const over = status(store, IDENTITY, at + STALENESS_MS + 1);
  expect(over.peers[0]?.stale).toBe(true);
  expect(over.panes.find((pane) => pane.pane === "%50")?.freshness).toBe("stale");
});

test("snapshot_at and fetched_at are not interchangeable", () => {
  // The two clocks. A node polled one second ago can be serving a three-hour-old
  // fact, and collapsing the two is how that read as fresh.
  const now = Date.now();
  const old = now - 3 * 3_600_000;
  store.addPeer("p", "p");
  store.replacePeerSnapshot("p", {
    ok: true,
    at: now,
    snapshot: remoteSnapshot([remoteAgentPane("%50", old)], old),
  });

  const view = status(store, IDENTITY, now);
  const pane = view.panes.find((candidate) => candidate.host_id === "REMOTE");

  // The NODE is fresh: we reached it just now.
  expect(pane?.freshness).toBe("fresh");
  expect(pane?.fetched_at).toBe(now);
  // The INFORMATION is not, and the view shows both.
  expect(pane?.snapshot_at).toBe(old);
  expect(pane?.updated_at).toBe(old);
  expect(view.peers[0]).toMatchObject({ fetched_at: now, snapshot_at: old, stale: false });
});

test("statusWithCollect awaits the collect before reading", async () => {
  // Regression: status() used to fire a fire-and-forget collect, so the view it
  // returned predated the sync that had just run, and the CLI's store.close()
  // in a finally raced the in-flight write -- "The database connection is not
  // open", which reads as corruption rather than a race.
  //
  // Needs a real peer and a channel we control: with no peers, collect is a
  // no-op loop and deleting the `await` leaves the test green.
  store.addPeer("dev", "dev");

  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const channel: Channel = {
    exec: async () => {
      await held;
      return JSON.stringify(remoteSnapshot([remotePane("%far")]));
    },
  };

  let settled = false;
  const pending = statusWithCollect(store, IDENTITY, Date.now(), channel).then((view) => {
    settled = true;
    return view;
  });

  await new Promise((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);

  release?.();
  const view = await pending;

  // And the returned view reflects the sync that just ran, not the one before.
  expect(view.panes.map((pane) => pane.pane)).toContain("%far");
  expect(view.peers[0]?.fetched_at).not.toBeNull();
  expect(() => store.close()).not.toThrow();
});
