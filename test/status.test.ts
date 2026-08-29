import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Channel } from "../src/channel.js";
import { ssh } from "../src/channel.js";
import { SCHEMA_VERSION } from "../src/export.js";
import { status, statusWithCollect, tmuxStatus } from "../src/status.js";
import { type NewEvent, openStore, type Store } from "../src/store.js";
import type { AgentState, Driver, Event } from "../src/types.js";

const stores: Store[] = [];
let store: Store;

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-status-"));
  store = openStore();
  stores.push(store);
  vi.spyOn(ssh, "exec").mockImplementation(async () => await new Promise<string>(() => {}));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const opened of stores.splice(0)) opened.close();
});

function newEvent(agentId: string, state: AgentState, driver: Driver | null = "human"): NewEvent {
  return {
    agent_id: agentId,
    session: "session",
    window: agentId,
    pane: `%${agentId}`,
    workstream: "murmur",
    role: null,
    cli: "pi",
    driver,
    kind: "state",
    state,
    message: "",
    pid: state === "working" ? process.pid : null,
    synthetic: false,
    reason: "",
    extra: {},
  };
}

function remoteEvent(
  seq: number,
  agentId: string,
  state: AgentState,
  driver: Driver | null = "human",
): Event {
  return {
    ...newEvent(agentId, state, driver),
    session_name: null,
    window_name: null,
    agent_name: null,
    pi_session: null,
    host_id: "remote-host",
    seq,
    ts: 1_000 + seq,
  };
}

test("counts group by folded state and a stale peer keeps its last state", () => {
  store.append(newEvent("working", "working"));
  store.append(newEvent("blocked", "blocked"));
  store.append(newEvent("crashed", "crashed"));
  store.append(newEvent("idle", "cleared"));
  store.ingest([remoteEvent(1, "remote-done", "done")]);
  store.upsertPeer({
    name: "dev",
    target: "dev",
    host_id: "remote-host",
    display_name: "Dev box",
    fetched_at: 1_000,
  });

  const result = status(store, 121_001);

  expect(result.counts).toEqual({ working: 1, blocked: 1, done: 1, crashed: 1, idle: 1 });
  expect(result.agents.find((agent) => agent.agent_id === "remote-done")).toMatchObject({
    state: "done",
    stale: true,
    age_ms: 120_001,
    // The configured peer name, not the machine's self-reported display_name:
    // that can be a container id nobody can type back at `peer remove`.
    host: "dev",
  });
});

test("stale is a view property, never an event state", () => {
  store.ingest([remoteEvent(1, "remote-crashed", "crashed")]);
  store.upsertPeer({
    name: "dev",
    target: "dev",
    host_id: "remote-host",
    fetched_at: 1_000,
  });

  const result = status(store, 121_001);

  expect(result.agents.map((agent) => agent.state)).not.toContain("stale");
  expect(result.agents.find((agent) => agent.agent_id === "remote-crashed")).toMatchObject({
    state: "crashed",
    stale: true,
  });
});

test("human and orchestrated agents are counted separately but both listed", () => {
  store.append(newEvent("human", "blocked", "human"));
  store.append(newEvent("crew-1", "working", "orchestrated"));
  store.append(newEvent("crew-2", "working", "orchestrated"));

  const result = status(store);

  expect(result.counts.blocked).toBe(1);
  expect(result.counts.working).toBe(0);
  expect(result.orchestrated_counts.working).toBe(2);
  expect(result.agents).toHaveLength(3);
});

test("tmux status emits urgent human counts without agent-supplied text", () => {
  const injection = "#(touch /tmp/pwned)";
  for (const [index, state] of ["crashed", "blocked", "done", "working", "cleared"].entries()) {
    const event = newEvent(`human-${index}`, state as AgentState);
    event.message = injection;
    event.workstream = injection;
    store.append(event);
  }
  store.append(newEvent(injection, "crashed", "orchestrated"));
  store.upsertPeer({
    name: "local",
    target: "local",
    host_id: store.allEvents()[0]?.host_id ?? null,
    display_name: injection,
    fetched_at: Date.now(),
  });

  const output = tmuxStatus(status(store));

  expect(output).toBe("crashed\t1\nblocked\t1\ndone\t1\nworking\t1\nidle\t1\n");
  expect(output).not.toContain(injection);
});

test("tmux status omits a crew-only fleet", () => {
  store.append(newEvent("crew", "working", "orchestrated"));

  expect(tmuxStatus(status(store))).toBe("");
});

test("tmux status keeps human and crew populations distinct", () => {
  store.append(newEvent("human", "blocked", "human"));
  store.append(newEvent("crew-1", "working", "orchestrated"));
  store.append(newEvent("crew-2", "working", "orchestrated"));

  expect(tmuxStatus(status(store))).toBe("blocked\t1\n");
});

test("a null driver reads as human", () => {
  store.ingest([remoteEvent(1, "old-agent", "done", null)]);

  const result = status(store);

  expect(result.agents.find((agent) => agent.agent_id === "old-agent")?.driver).toBe("human");
  expect(result.counts.done).toBe(1);
});

test("status works with no peers configured", () => {
  const localHostId = store.append(newEvent("local", "working")).host_id;

  const result = status(store);

  expect(result.peers).toEqual([]);
  expect(result.counts.working).toBe(1);
  expect(result.agents.find((agent) => agent.agent_id === "local")).toMatchObject({
    host_id: localHostId,
    stale: false,
    age_ms: null,
  });
});

test("statusWithCollect awaits the collect before folding", async () => {
  // Regression: status() used to fire a fire-and-forget collect, so the view
  // it returned predated the sync that had just run, and the CLI's
  // store.close() in a finally raced the in-flight write —
  // "The database connection is not open", which reads as corruption rather
  // than a race. Awaiting fixes both: fresh data, and no write after close.
  //
  // This needs a real peer and a channel we control. The earlier version ran
  // with no peers, which made collect a no-op loop -- so deleting the `await`,
  // or the whole collect call, left it green. It asserted nothing.
  const store = openStore();
  store.upsertPeer({ name: "dev", target: "dev" });

  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const channel: Channel = {
    exec: async () => {
      await held;
      return [
        JSON.stringify({
          schema_version: SCHEMA_VERSION,
          host_id: "remote",
          display_name: "Remote",
          exported_at: 1,
        }),
        JSON.stringify({ ...remoteEvent(1, "far", "working"), host_id: "remote" }),
      ].join("\n");
    },
  };

  let settled = false;
  const pending = statusWithCollect(store, Date.now(), channel).then((view) => {
    settled = true;
    return view;
  });

  // Still in flight while the export is held: proof the collect is awaited
  // rather than fired and forgotten.
  await new Promise((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);

  release?.();
  const view = await pending;

  // And the returned view reflects the sync that just ran, not the one before.
  expect(view.agents.map((agent) => agent.agent_id)).toContain("far");
  expect(view.peers[0]?.fetched_at).not.toBeNull();
  expect(() => store.close()).not.toThrow();
});

test("a peer that has never been reached is stale, not fresh", () => {
  // isStale treats a null fetched_at as "local data, never stale", which is
  // correct for an agent row and backwards for a peer: null there means the
  // first collect has not succeeded. Found live — an unreachable host added
  // with `peer add` rendered as up to date.
  const store = openStore();
  store.upsertPeer({ name: "ghost", target: "192.0.2.1" });
  const view = status(store);
  expect(view.peers[0]?.fetched_at).toBeNull();
  expect(view.peers[0]?.stale).toBe(true);
});

test("event age is not reset by a successful fetch", () => {
  // The bug a user spotted in the picker: two bubba agents showed no age at
  // all, because age_ms measured how recently we reached the PEER, not how old
  // the agent's news was. Collecting a three-hour-old event set age_ms to 0
  // and stale to false, so a dead host's rows read as live.
  const store = openStore();
  const old = Date.now() - 3 * 3_600_000;
  store.ingest([{ ...remoteEvent(1, "stale-agent", "blocked"), ts: old }]);
  store.upsertPeer({
    name: "p",
    target: "p",
    host_id: "remote-host",
    fetched_at: Date.now(),
  });
  const view = status(store);
  const agent = view.agents.find((candidate) => candidate.host_id === "remote-host");
  // Replica is fresh: we reached the peer just now.
  expect(agent?.stale).toBe(false);
  expect(agent?.age_ms).toBeLessThan(60_000);
  // The information is not.
  expect(agent?.event_age_ms).toBeGreaterThan(2.9 * 3_600_000);
});
