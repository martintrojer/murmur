import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { asPaneId, asSessionId, asWindowId, type PaneId } from "../src/ids.js";
import { dbPath } from "../src/paths.js";
import { openStore, type Store } from "../src/store.js";
import type { AgentMeta, Location } from "../src/types.js";

/**
 * Every test here is a claim about what is IMPOSSIBLE, and each one names the
 * shipped incident it closes. The store is where category confusion used to be
 * expressible -- a notifier writing an agent's activity, a nested pi claiming a
 * live pane, a focus hook nulling owner metadata -- so these are the assertions
 * the schema exists to satisfy.
 */

const stores: Store[] = [];

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-store-"));
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

function location(pane = "%1", over: Partial<Location> = {}): Location {
  return {
    session: asSessionId("$0"),
    window: asWindowId("@0"),
    pane: asPaneId(pane),
    session_name: "work",
    window_name: "worker-1",
    ...over,
  };
}

function meta(over: Partial<AgentMeta> = {}): AgentMeta {
  return {
    agent_name: "worker-1",
    pi_session: null,
    workstream: "murmur",
    role: null,
    cli: "pi",
    driver: "orchestrated",
    ...over,
  };
}

/** Every column of the agents table, straight from SQLite. */
function agentRows(): Record<string, unknown>[] {
  const database = new Database(dbPath(), { readonly: true });
  try {
    return database.prepare("SELECT * FROM agents ORDER BY pane").all() as Record<
      string,
      unknown
    >[];
  } finally {
    database.close();
  }
}

const alive = (pids: number[]) => (pid: number) => pids.includes(pid);
const dead = () => false;

// --- claim ----------------------------------------------------------------

test("claiming a free pane inserts a stopped agent with a fresh uuid", () => {
  const s = store();

  const result = s.claimAgent({ location: location(), owner_pid: 100, meta: meta(), now: 5 });

  expect(result.outcome).toBe("claimed");
  const panes = s.localPanes();
  expect(panes).toHaveLength(1);
  expect(panes[0]?.agent).toMatchObject({
    activity: "stopped",
    claimed_at: 5,
    updated_at: 5,
    agent_name: "worker-1",
    driver: "orchestrated",
  });
  // Not derived from the pane: a replacement owner must be a different row, so
  // a late write from the previous owner cannot match it.
  expect(panes[0]?.agent?.agent_id).not.toContain("%1");
});

test("re-claiming as the same pid retains the agent_id and the activity", () => {
  // pi re-runs the extension factory in the same process on /reload. A check
  // that could not recognise its own claim would silence the real agent.
  const s = store();
  const first = s.claimAgent({ location: location(), owner_pid: 100, meta: meta(), now: 1 });
  const agentId = "agent_id" in first ? first.agent_id : "";
  s.setActivity({
    agent_id: agentId,
    owner_pid: 100,
    activity: "running",
    location: location(),
    now: 2,
  });

  const again = s.claimAgent({
    location: location(),
    owner_pid: 100,
    meta: meta({ role: "reviewer" }),
    now: 3,
  });

  expect(again).toEqual({ outcome: "retained", agent_id: agentId });
  expect(s.localPanes()[0]?.agent).toMatchObject({
    agent_id: agentId,
    activity: "running",
    role: "reviewer",
    claimed_at: 1,
    updated_at: 3,
  });
});

test("a second live process claiming an owned pane is refused and writes nothing", () => {
  const s = store();
  s.claimAgent({ location: location(), owner_pid: 100, meta: meta(), now: 1 });
  const before = agentRows();

  const result = s.claimAgent({
    location: location(),
    owner_pid: 200,
    meta: meta({ agent_name: "nested" }),
    now: 2,
    isAlive: alive([100]),
  });

  expect(result).toEqual({ outcome: "refused", held_by_pid: 100 });
  expect(agentRows()).toEqual(before);
});

test("an unprobeable owner refuses the new claimant: liveness fails closed", () => {
  // pidAlive reports death only on ESRCH, so EPERM reads as alive. An unknown
  // must never let a second writer displace a possibly-live owner.
  const s = store();
  s.claimAgent({ location: location(), owner_pid: 100, meta: meta() });

  const result = s.claimAgent({
    location: location(),
    owner_pid: 200,
    meta: meta(),
    isAlive: () => true,
  });

  expect(result.outcome).toBe("refused");
});

test("a dead owner is replaced with a new agent_id, and its writes then fail", () => {
  const s = store();
  const first = s.claimAgent({ location: location(), owner_pid: 100, meta: meta(), now: 1 });
  const oldId = "agent_id" in first ? first.agent_id : "";

  const replaced = s.claimAgent({
    location: location(),
    owner_pid: 200,
    meta: meta(),
    now: 2,
    isAlive: dead,
  });

  expect(replaced.outcome).toBe("replaced");
  expect("previous_agent_id" in replaced && replaced.previous_agent_id).toBe(oldId);
  const newId = "agent_id" in replaced ? replaced.agent_id : "";
  expect(newId).not.toBe(oldId);
  // The previous owner is now a stranger to the store.
  expect(
    s.setActivity({
      agent_id: oldId,
      owner_pid: 100,
      activity: "running",
      location: location(),
    }),
  ).toBe(false);
  expect(s.releaseAgent({ agent_id: oldId, owner_pid: 100 })).toBe(false);
});

test("replacing a dead owner clears the previous occupant's attention", () => {
  // That attention described a process that is gone; a human looking at the
  // pane now sees a different agent.
  const s = store();
  s.claimAgent({ location: location(), owner_pid: 100, meta: meta() });
  s.requestAttention({ kind: "done", location: location(), message: "", source: "pi" });

  s.claimAgent({ location: location(), owner_pid: 200, meta: meta(), isAlive: dead });

  expect(s.localPanes()[0]?.attention).toEqual([]);
});

// --- activity -------------------------------------------------------------

test("setActivity requires the owner pid and cannot create a row", () => {
  const s = store();
  const claim = s.claimAgent({ location: location(), owner_pid: 100, meta: meta(), now: 1 });
  const agentId = "agent_id" in claim ? claim.agent_id : "";

  expect(
    s.setActivity({
      agent_id: agentId,
      owner_pid: 999,
      activity: "running",
      location: location(),
      now: 2,
    }),
  ).toBe(false);
  expect(s.localPanes()[0]?.agent?.activity).toBe("stopped");

  expect(
    s.setActivity({
      agent_id: "no-such-agent",
      owner_pid: 100,
      activity: "running",
      location: location(),
    }),
  ).toBe(false);
  expect(agentRows()).toHaveLength(1);

  expect(
    s.setActivity({
      agent_id: agentId,
      owner_pid: 100,
      activity: "running",
      location: location("%1", { window: asWindowId("@9") }),
      now: 7,
    }),
  ).toBe(true);
  expect(s.localPanes()[0]).toMatchObject({ window: "@9" });
  expect(s.localPanes()[0]?.agent).toMatchObject({ activity: "running", updated_at: 7 });
});

test("releaseAgent keeps attention, so a done raised at settle survives the exit", () => {
  const s = store();
  const claim = s.claimAgent({ location: location(), owner_pid: 100, meta: meta() });
  const agentId = "agent_id" in claim ? claim.agent_id : "";
  s.requestAttention({ kind: "done", location: location(), message: "finished", source: "pi" });

  expect(s.releaseAgent({ agent_id: agentId, owner_pid: 100 })).toBe(true);

  const panes = s.localPanes();
  expect(panes[0]?.agent).toBeNull();
  expect(panes[0]?.attention).toEqual([
    { kind: "done", message: "finished", source: "pi", requested_at: expect.any(Number) },
  ]);
});

// --- attention cannot touch an agent -------------------------------------

test("a notifier cannot change any agent field", () => {
  const s = store();
  s.claimAgent({ location: location(), owner_pid: 100, meta: meta(), now: 1 });
  const before = agentRows();

  for (const kind of ["done", "blocked", "crashed"] as const) {
    s.requestAttention({
      kind,
      location: location(),
      message: "someone is wanted",
      source: "codex",
      now: 50,
    });
  }

  expect(agentRows()).toEqual(before);
});

test("notify then clear leaves a live agent's row byte-for-byte unchanged", () => {
  // The regression test for the measured incident: under the event model this
  // sequence replaced `working` with `blocked` and nulled agent_name,
  // workstream, role and driver on panes %250-%252 while all three pi
  // processes were alive.
  const s = store();
  const claim = s.claimAgent({ location: location("%250"), owner_pid: 100, meta: meta(), now: 1 });
  const agentId = "agent_id" in claim ? claim.agent_id : "";
  s.setActivity({
    agent_id: agentId,
    owner_pid: 100,
    activity: "running",
    location: location("%250"),
    now: 2,
  });
  const before = agentRows();

  s.requestAttention({
    kind: "blocked",
    location: location("%250"),
    message: "needs input",
    source: "stdin-probe",
    now: 3,
  });
  s.acknowledgePane(asPaneId("%250"));

  expect(agentRows()).toEqual(before);
  expect(before[0]).toMatchObject({
    activity: "running",
    agent_name: "worker-1",
    workstream: "murmur",
    driver: "orchestrated",
  });
});

test("a repeated attention request does not reset requested_at", () => {
  // Age means "how long this has gone unmet", so a repeat must not restart the
  // clock -- which also makes crash attention idempotent for free.
  const s = store();
  s.requestAttention({ kind: "blocked", location: location(), message: "a", source: "x", now: 10 });
  s.requestAttention({ kind: "blocked", location: location(), message: "b", source: "y", now: 99 });

  expect(s.localPanes()[0]?.attention).toEqual([
    { kind: "blocked", message: "b", source: "y", requested_at: 10 },
  ]);
});

test("kinds coexist on one pane, and acknowledge clears them all for that pane only", () => {
  const s = store();
  for (const kind of ["crashed", "blocked", "done"] as const) {
    s.requestAttention({ kind, location: location("%1"), message: kind, source: "x" });
  }
  s.requestAttention({ kind: "done", location: location("%2"), message: "", source: "x" });

  expect(s.localPanes()[0]?.attention.map((entry) => entry.kind)).toEqual([
    "crashed",
    "blocked",
    "done",
  ]);
  expect(s.acknowledgePane(asPaneId("%1"))).toBe(3);
  expect(s.localPanes().map((pane) => pane.pane)).toEqual(["%2"]);
});

// --- reconciliation ------------------------------------------------------

test("reconcileLocal with panes null writes nothing", () => {
  // tmux failing to answer is absence of evidence, not evidence of death.
  const s = store();
  s.claimAgent({ location: location(), owner_pid: 100, meta: meta() });
  s.requestAttention({ kind: "done", location: location(), message: "", source: "pi" });
  const before = agentRows();

  expect(s.reconcileLocal({ panes: null, isAlive: dead })).toEqual({
    crashed: [],
    removed: [],
    attention_removed: [],
  });
  expect(agentRows()).toEqual(before);
  expect(s.localPanes()[0]?.attention).toHaveLength(1);
});

test("a dead running owner becomes stopped plus one crashed row, idempotently", () => {
  const s = store();
  const claim = s.claimAgent({ location: location(), owner_pid: 100, meta: meta(), now: 1 });
  const agentId = "agent_id" in claim ? claim.agent_id : "";
  s.setActivity({
    agent_id: agentId,
    owner_pid: 100,
    activity: "running",
    location: location(),
    now: 2,
  });

  const first = s.reconcileLocal({
    panes: new Set([asPaneId("%1")]),
    isAlive: dead,
    now: 10,
  });

  expect(first.crashed).toEqual(["%1"]);
  expect(s.localPanes()[0]?.agent?.activity).toBe("stopped");
  expect(s.localPanes()[0]?.attention).toEqual([
    { kind: "crashed", message: "", source: "murmur", requested_at: 10 },
  ]);

  const after = agentRows();
  s.reconcileLocal({ panes: new Set([asPaneId("%1")]), isAlive: dead, now: 999 });
  expect(agentRows()).toEqual(after);
  expect(s.localPanes()[0]?.attention[0]?.requested_at).toBe(10);
});

test("a vanished pane loses its agent and its attention; a stopped dead owner keeps attention", () => {
  const s = store();
  // Gone pane, with attention.
  s.claimAgent({ location: location("%1"), owner_pid: 100, meta: meta() });
  s.requestAttention({ kind: "done", location: location("%1"), message: "", source: "pi" });
  // Live pane, stopped owner that died after finishing, with a done nobody saw.
  s.claimAgent({ location: location("%2"), owner_pid: 200, meta: meta() });
  s.requestAttention({ kind: "done", location: location("%2"), message: "seen me", source: "pi" });

  const summary = s.reconcileLocal({ panes: new Set([asPaneId("%2")]), isAlive: dead });

  expect(summary.removed).toEqual(["%1", "%2"]);
  const panes = s.localPanes();
  expect(panes.map((pane) => pane.pane)).toEqual(["%2"]);
  expect(panes[0]?.agent).toBeNull();
  expect(panes[0]?.attention.map((entry) => entry.message)).toEqual(["seen me"]);
});

test("attention for a pane that never had an agent is reaped when the pane goes", () => {
  const s = store();
  s.requestAttention({ kind: "blocked", location: location("%7"), message: "", source: "codex" });

  const summary = s.reconcileLocal({ panes: new Set<PaneId>(), isAlive: dead });

  expect(summary.attention_removed).toEqual(["%7"]);
  expect(s.localPanes()).toEqual([]);
});

// --- local read and snapshot shape ---------------------------------------

test("localPanes joins by pane and exposes no owner_pid anywhere", () => {
  const s = store();
  s.claimAgent({ location: location("%1"), owner_pid: 100, meta: meta() });
  s.requestAttention({ kind: "done", location: location("%1"), message: "", source: "pi" });
  s.claimAgent({ location: location("%2"), owner_pid: 200, meta: meta() });
  s.requestAttention({ kind: "blocked", location: location("%3"), message: "", source: "codex" });

  const panes = s.localPanes();

  expect(panes.map((pane) => pane.pane)).toEqual(["%1", "%2", "%3"]);
  expect(panes[1]?.attention).toEqual([]);
  expect(panes[2]?.agent).toBeNull();
  // Structurally, over the whole object graph -- not by reading the type.
  expect(JSON.stringify(panes)).not.toContain("owner_pid");
  expect(JSON.stringify(panes)).not.toContain("100");
});

test("buildLocalSnapshot reconciles, drops empty panes and never carries a pid", () => {
  const s = store();
  s.claimAgent({ location: location("%1"), owner_pid: process.pid, meta: meta(), now: 1 });
  s.claimAgent({ location: location("%gone"), owner_pid: 100, meta: meta(), now: 1 });

  const snapshot = s.buildLocalSnapshot(
    { host_id: "H", display_name: "here" },
    { panes: new Set([asPaneId("%1")]), isAlive: alive([process.pid]), now: 42 },
  );

  expect(snapshot).toMatchObject({
    murmur_snapshot: 1,
    host_id: "H",
    display_name: "here",
    generated_at: 42,
  });
  expect(snapshot.murmur_version).toMatch(/^\d+\.\d+\.\d+/);
  expect(snapshot.panes.map((pane) => pane.pane)).toEqual(["%1"]);
  expect(JSON.stringify(snapshot)).not.toContain("owner_pid");
});

// --- peers ---------------------------------------------------------------

test("a successful fetch replaces the whole document; a pane absent after is gone", () => {
  const s = store();
  s.addPeer("dev", "dev.example");
  const base = {
    murmur_snapshot: 1 as const,
    host_id: "REMOTE",
    display_name: "dev",
    murmur_version: "9.9.9",
    generated_at: 1_000,
    panes: [],
  };
  s.replacePeerSnapshot("dev", {
    ok: true,
    at: 2_000,
    snapshot: {
      ...base,
      panes: [
        {
          pane: asPaneId("%1"),
          session: asSessionId("$0"),
          window: asWindowId("@0"),
          session_name: null,
          window_name: null,
          agent: null,
          attention: [{ kind: "done", message: "", source: "pi", requested_at: 1 }],
        },
      ],
    },
  });

  s.replacePeerSnapshot("dev", { ok: true, at: 3_000, snapshot: { ...base, generated_at: 2_500 } });

  const peer = s.peers()[0];
  expect(peer?.snapshot?.panes).toEqual([]);
  // Two clocks, never interchangeable: theirs says when the document was built,
  // ours when we reached them, and freshness reads only ours.
  expect(peer).toMatchObject({
    host_id: "REMOTE",
    display_name: "dev",
    murmur_version: "9.9.9",
    snapshot_version: 1,
    snapshot_at: 2_500,
    fetched_at: 3_000,
    last_attempt_at: 3_000,
    last_error: null,
  });
});

test("a failed fetch keeps the previous snapshot and leaves fetched_at alone", () => {
  const s = store();
  s.addPeer("dev", "dev.example");
  s.replacePeerSnapshot("dev", {
    ok: true,
    at: 1_000,
    snapshot: {
      murmur_snapshot: 1,
      host_id: "REMOTE",
      display_name: "dev",
      murmur_version: "1.0.0",
      generated_at: 900,
      panes: [],
    },
  });

  s.replacePeerSnapshot("dev", { ok: false, at: 5_000, error: "Host is down" });

  expect(s.peers()[0]).toMatchObject({
    snapshot: { host_id: "REMOTE" },
    fetched_at: 1_000,
    last_attempt_at: 5_000,
    last_error: "Host is down",
  });
});

test("addPeer corrects a target without discarding the cache", () => {
  const s = store();
  s.addPeer("dev", "old.example");
  s.replacePeerSnapshot("dev", {
    ok: true,
    at: 1_000,
    snapshot: {
      murmur_snapshot: 1,
      host_id: "REMOTE",
      display_name: "dev",
      murmur_version: "1.0.0",
      generated_at: 900,
      panes: [],
    },
  });

  s.addPeer("dev", "new.example");

  expect(s.peers()[0]).toMatchObject({ target: "new.example", snapshot: { host_id: "REMOTE" } });
  expect(s.removePeer("dev")).toBe(true);
  expect(s.removePeer("dev")).toBe(false);
});

// --- constraints, asserted where SQLite itself is the enforcer -----------

test("SQLite refuses a second agent row for one pane", () => {
  const s = store();
  s.claimAgent({ location: location(), owner_pid: 100, meta: meta() });
  s.close();

  const database = new Database(dbPath());
  try {
    const insert = () =>
      database
        .prepare(
          `INSERT INTO agents (agent_id, pane, owner_pid, activity, session, window, cli,
                               driver, claimed_at, updated_at)
           VALUES (?, '%1', 1, 'running', '$0', '@0', 'pi', 'human', 0, 0)`,
        )
        .run("second");
    expect(insert).toThrow(/UNIQUE/);
  } finally {
    database.close();
  }
});

test.each([
  [
    "activity",
    "INSERT INTO agents (agent_id, pane, owner_pid, activity, session, window, cli, driver, claimed_at, updated_at) VALUES ('a', '%9', 1, 'working', '$0', '@0', 'pi', 'human', 0, 0)",
  ],
  [
    "driver",
    "INSERT INTO agents (agent_id, pane, owner_pid, activity, session, window, cli, driver, claimed_at, updated_at) VALUES ('a', '%9', 1, 'running', '$0', '@0', 'pi', 'robot', 0, 0)",
  ],
  [
    "owner_pid",
    "INSERT INTO agents (agent_id, pane, owner_pid, activity, session, window, cli, driver, claimed_at, updated_at) VALUES ('a', '%9', 0, 'running', '$0', '@0', 'pi', 'human', 0, 0)",
  ],
  [
    "kind",
    "INSERT INTO attention (pane, kind, message, source, session, window, requested_at) VALUES ('%9', 'working', '', 'x', '$0', '@0', 0)",
  ],
])("SQLite refuses an out-of-enum %s", (_field, sql) => {
  const s = store();
  s.close();
  const database = new Database(dbPath());
  try {
    expect(() => database.prepare(sql).run()).toThrow(/CHECK constraint/);
  } finally {
    database.close();
  }
});

// --- identity and legacy -------------------------------------------------

test("openStore mints no identity", async () => {
  const { loadIdentity } = await import("../src/identity.js");
  expect(loadIdentity()).toBeNull();

  store();

  expect(loadIdentity()).toBeNull();
});

test("a database from an older version is recreated with the peer names salvaged", () => {
  const s = store();
  s.addPeer("dev", "dev.example");
  s.replacePeerSnapshot("dev", {
    ok: true,
    at: 1_000,
    snapshot: {
      murmur_snapshot: 1,
      host_id: "REMOTE",
      display_name: "dev",
      murmur_version: "1.0.0",
      generated_at: 900,
      panes: [],
    },
  });
  s.claimAgent({ location: location(), owner_pid: 100, meta: meta() });
  s.close();

  const database = new Database(dbPath());
  database.pragma("user_version = 1");
  database.close();

  const reopened = store();

  // The two fields a human typed survive; every observed column starts empty,
  // so a never-reached peer cannot render as fresh.
  expect(reopened.peers()).toEqual([
    {
      name: "dev",
      target: "dev.example",
      host_id: null,
      display_name: null,
      snapshot: null,
      snapshot_at: null,
      fetched_at: null,
      last_attempt_at: null,
      last_error: null,
      murmur_version: null,
      snapshot_version: null,
    },
  ]);
  expect(reopened.localPanes()).toEqual([]);
});
