import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { NodeIdentity } from "./identity.js";
import type { PaneId } from "./ids.js";
import { asPaneId, asSessionId, asWindowId } from "./ids.js";
import { pidAlive } from "./mux.js";
import { dbPath, stateDir } from "./paths.js";
import type {
  ActivityUpdate,
  AgentClaim,
  AgentRelease,
  AttentionKind,
  AttentionRequest,
  ClaimResult,
  LocalWorld,
  PeerFetch,
  PeerRecord,
  ReconcileSummary,
  Snapshot,
  SnapshotAgent,
  SnapshotAttention,
  SnapshotPane,
} from "./types.js";
import { MURMUR_VERSION } from "./version.js";
import { RENDER_PRIORITY } from "./view.js";

/**
 * The storage version. Any change to any table bumps it.
 *
 * There is ONE version strategy, not two: a mismatch salvages the peer names
 * and targets a human typed, deletes the file, and recreates the schema. No
 * ALTER TABLE anywhere, so there is no additive path to forget to use — which
 * is the fragility the dual-strategy store had.
 */
const SCHEMA_USER_VERSION = 3;

const SCHEMA = `
  CREATE TABLE agents (
    agent_id     TEXT    NOT NULL PRIMARY KEY,
    pane         TEXT    NOT NULL UNIQUE,
    owner_pid    INTEGER NOT NULL CHECK (owner_pid > 0),
    activity     TEXT    NOT NULL CHECK (activity IN ('running', 'stopped')),
    session      TEXT    NOT NULL,
    window       TEXT    NOT NULL,
    session_name TEXT,
    window_name  TEXT,
    agent_name   TEXT,
    pi_session   TEXT,
    workstream   TEXT,
    role         TEXT,
    cli          TEXT    NOT NULL,
    driver       TEXT    NOT NULL CHECK (driver IN ('human', 'orchestrated')),
    claimed_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE attention (
    pane         TEXT    NOT NULL,
    kind         TEXT    NOT NULL CHECK (kind IN ('done', 'blocked', 'crashed')),
    message      TEXT    NOT NULL,
    source       TEXT    NOT NULL,
    session      TEXT    NOT NULL,
    window       TEXT    NOT NULL,
    session_name TEXT,
    window_name  TEXT,
    requested_at INTEGER NOT NULL,
    PRIMARY KEY (pane, kind)
  ) STRICT;

  CREATE TABLE peers (
    name             TEXT NOT NULL PRIMARY KEY,
    target           TEXT NOT NULL,
    host_id          TEXT,
    display_name     TEXT,
    snapshot         TEXT,
    snapshot_at      INTEGER,
    fetched_at       INTEGER,
    last_attempt_at  INTEGER,
    last_error       TEXT,
    murmur_version   TEXT,
    snapshot_version INTEGER
  ) STRICT;
`;

/**
 * The store, and the only place in murmur that holds a database handle or
 * writes SQL.
 *
 * This interface is CLOSED. There is no `append`, no `ingest`, no log read, no
 * partial-row update, and no local read other than `localPanes` — each of those
 * shapes let a writer say something it had no standing to say, and each cost a
 * shipped bug. Attention methods take no agent identity at all, which is what
 * makes "a notifier cannot corrupt an agent row" structural.
 */
export interface Store {
  // --- agent lifecycle: owner-only, pid-gated -----------------------------
  claimAgent(claim: AgentClaim): ClaimResult;
  setActivity(update: ActivityUpdate): boolean;
  releaseAgent(release: AgentRelease): boolean;

  // --- attention: pane-addressed, no agent authority ----------------------
  requestAttention(request: AttentionRequest): void;
  acknowledgePane(pane: PaneId): number;

  // --- local truth --------------------------------------------------------
  /** The one local read. Joins agents and attention by pane. No reconciliation. */
  localPanes(): SnapshotPane[];
  reconcileLocal(world: LocalWorld): ReconcileSummary;
  buildLocalSnapshot(identity: NodeIdentity, world: LocalWorld): Snapshot;

  // --- peer cache ---------------------------------------------------------
  peers(): PeerRecord[];
  addPeer(name: string, target: string): void;
  removePeer(name: string): boolean;
  replacePeerSnapshot(name: string, fetch: PeerFetch): void;

  close(): void;
}

type AgentDbRow = {
  agent_id: string;
  pane: string;
  owner_pid: number;
  activity: string;
  session: string;
  window: string;
  session_name: string | null;
  window_name: string | null;
  agent_name: string | null;
  pi_session: string | null;
  workstream: string | null;
  role: string | null;
  cli: string;
  driver: string;
  claimed_at: number;
  updated_at: number;
};

type AttentionDbRow = {
  pane: string;
  kind: string;
  message: string;
  source: string;
  session: string;
  window: string;
  session_name: string | null;
  window_name: string | null;
  requested_at: number;
};

type PeerDbRow = {
  name: string;
  target: string;
  host_id: string | null;
  display_name: string | null;
  snapshot: string | null;
  snapshot_at: number | null;
  fetched_at: number | null;
  last_attempt_at: number | null;
  last_error: string | null;
  murmur_version: string | null;
  snapshot_version: number | null;
};

/**
 * Delete every trace of the pre-rewrite event log, once per open.
 *
 * Best effort and unconditional: `events.db` is not read, not migrated and not
 * written by any code path, so a file left behind is dead weight that a future
 * reader could mistake for state. The sidecars go too — a stale -wal against a
 * missing main file is a documented way to confuse sqlite.
 */
function removeLegacyLog(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${stateDir()}/events.db${suffix}`, { force: true });
    } catch {
      // A read-only state dir is not a reason to fail opening the store.
    }
  }
}

/** Peer names and targets: the two fields a human typed, and all we salvage. */
function salvagePeers(path: string): { name: string; target: string }[] {
  try {
    const existing = new Database(path, { fileMustExist: true });
    try {
      const version = (existing.pragma("user_version", { simple: true }) as number) ?? 0;
      if (version === SCHEMA_USER_VERSION) return [];
      return existing.prepare("SELECT name, target FROM peers").all() as {
        name: string;
        target: string;
      }[];
    } catch {
      // Too old to have the table, or unreadable. Nothing to save.
      return [];
    } finally {
      existing.close();
    }
  } catch {
    // No database yet, or one too broken to open.
    return [];
  }
}

function needsReset(path: string): boolean {
  try {
    const existing = new Database(path, { fileMustExist: true });
    try {
      return (
        ((existing.pragma("user_version", { simple: true }) as number) ?? 0) !== SCHEMA_USER_VERSION
      );
    } finally {
      existing.close();
    }
  } catch {
    return false;
  }
}

function toAttention(row: AttentionDbRow): SnapshotAttention {
  return {
    kind: row.kind as AttentionKind,
    message: row.message,
    source: row.source,
    requested_at: row.requested_at,
  };
}

function toAgent(row: AgentDbRow): SnapshotAgent {
  return {
    agent_id: row.agent_id,
    activity: row.activity as SnapshotAgent["activity"],
    agent_name: row.agent_name,
    pi_session: row.pi_session,
    workstream: row.workstream,
    role: row.role,
    cli: row.cli,
    driver: row.driver as SnapshotAgent["driver"],
    claimed_at: row.claimed_at,
    updated_at: row.updated_at,
  };
}

const PRIORITY = new Map<string, number>(RENDER_PRIORITY.map((kind, index) => [kind, index]));

function attentionOrder(left: SnapshotAttention, right: SnapshotAttention): number {
  return (PRIORITY.get(left.kind) ?? 99) - (PRIORITY.get(right.kind) ?? 99);
}

/**
 * Open the store. Takes no arguments and mints no identity.
 *
 * `openStore` deliberately does NOT read or create `identity.json`: identity is
 * created only by `murmur init`, so a read path — a status-bar tick, a focus
 * hook — cannot bring a node into existence as a side effect.
 */
export function openStore(): Store {
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  removeLegacyLog();

  const salvaged = salvagePeers(path);
  if (needsReset(path)) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  }

  const database = new Database(path);
  database.pragma("journal_mode = WAL");
  database.pragma("busy_timeout = 5000");
  const version = (database.pragma("user_version", { simple: true }) as number) ?? 0;
  if (version !== SCHEMA_USER_VERSION) {
    database.exec(SCHEMA);
    database.pragma(`user_version = ${SCHEMA_USER_VERSION}`);
    // Re-inserted with every OBSERVED column null: a salvaged peer has no
    // snapshot and has never been fetched, and saying otherwise would render a
    // never-reached host as fresh.
    const restore = database.prepare("INSERT OR IGNORE INTO peers (name, target) VALUES (?, ?)");
    for (const peer of salvaged) restore.run(peer.name, peer.target);
  }

  const selectAgentByPane = database.prepare("SELECT * FROM agents WHERE pane = ?");
  const insertAgent = database.prepare(`
    INSERT INTO agents (agent_id, pane, owner_pid, activity, session, window,
                        session_name, window_name, agent_name, pi_session,
                        workstream, role, cli, driver, claimed_at, updated_at)
    VALUES (@agent_id, @pane, @owner_pid, @activity, @session, @window,
            @session_name, @window_name, @agent_name, @pi_session,
            @workstream, @role, @cli, @driver, @claimed_at, @updated_at)
  `);
  const retainAgent = database.prepare(`
    UPDATE agents
       SET session = @session, window = @window, session_name = @session_name,
           window_name = @window_name, agent_name = @agent_name,
           pi_session = @pi_session, workstream = @workstream, role = @role,
           cli = @cli, driver = @driver, updated_at = @updated_at
     WHERE agent_id = @agent_id
  `);
  const deleteAgentByPane = database.prepare("DELETE FROM agents WHERE pane = ?");
  const deleteAttentionForPane = database.prepare("DELETE FROM attention WHERE pane = ?");
  const updateActivity = database.prepare(`
    UPDATE agents
       SET activity = @activity, session = @session, window = @window,
           session_name = @session_name, window_name = @window_name,
           updated_at = @updated_at
     WHERE agent_id = @agent_id AND owner_pid = @owner_pid
  `);
  const deleteAgentOwned = database.prepare(
    "DELETE FROM agents WHERE agent_id = ? AND owner_pid = ?",
  );
  const upsertAttention = database.prepare(`
    INSERT INTO attention (pane, kind, message, source, session, window,
                           session_name, window_name, requested_at)
    VALUES (@pane, @kind, @message, @source, @session, @window,
            @session_name, @window_name, @requested_at)
    ON CONFLICT (pane, kind) DO UPDATE SET
      message = excluded.message,
      source = excluded.source,
      session = excluded.session,
      window = excluded.window,
      session_name = excluded.session_name,
      window_name = excluded.window_name
  `);
  const selectAgents = database.prepare("SELECT * FROM agents");
  const selectAttention = database.prepare("SELECT * FROM attention");
  const setActivityByPane = database.prepare(
    "UPDATE agents SET activity = ?, updated_at = ? WHERE pane = ?",
  );

  /**
   * `.immediate`, not deferred, and this is load-bearing.
   *
   * The transaction reads the incumbent row and then writes, so a deferred one
   * starts as a READER and must upgrade. Two doing that at once fails the loser
   * with SQLITE_BUSY_SNAPSHOT, which no busy_timeout can fix: waiting longer
   * cannot make a stale snapshot fresh. Measured previously at 5 of 8
   * concurrent writers failing.
   */
  const claimAgent = database.transaction((claim: AgentClaim): ClaimResult => {
    const now = claim.now ?? Date.now();
    const isAlive = claim.isAlive ?? pidAlive;
    const { location, meta, owner_pid } = claim;
    const incumbent = selectAgentByPane.get(location.pane) as AgentDbRow | undefined;

    const values = {
      pane: location.pane,
      owner_pid,
      session: location.session,
      window: location.window,
      session_name: location.session_name,
      window_name: location.window_name,
      agent_name: meta.agent_name,
      pi_session: meta.pi_session,
      workstream: meta.workstream,
      role: meta.role,
      cli: meta.cli,
      driver: meta.driver,
      updated_at: now,
    };

    if (!incumbent) {
      const agentId = randomUUID();
      insertAgent.run({ ...values, agent_id: agentId, activity: "stopped", claimed_at: now });
      return { outcome: "claimed", agent_id: agentId };
    }

    // Our own claim, seen again. This is what makes pi's `/reload` a no-op: pi
    // re-runs the extension factory in the same process, and a check that could
    // not recognise its own claim would silence the real agent. `activity` and
    // `agent_id` are deliberately untouched.
    if (incumbent.owner_pid === owner_pid) {
      retainAgent.run({ ...values, agent_id: incumbent.agent_id });
      return { outcome: "retained", agent_id: incumbent.agent_id };
    }

    // A different LIVE process in one pane: the nested-agent case, and the only
    // answer for it. Fails closed — `pidAlive` reports death only on ESRCH, so
    // an unanswerable probe (EPERM) reads as alive and refuses. An unknown must
    // never let a second writer displace a possibly-live owner.
    if (isAlive(incumbent.owner_pid)) {
      return { outcome: "refused", held_by_pid: incumbent.owner_pid };
    }

    // The previous occupant is gone. Its attention described a process that no
    // longer exists, and a human looking at the pane now sees a different agent.
    deleteAgentByPane.run(location.pane);
    deleteAttentionForPane.run(location.pane);
    const agentId = randomUUID();
    insertAgent.run({ ...values, agent_id: agentId, activity: "stopped", claimed_at: now });
    return { outcome: "replaced", agent_id: agentId, previous_agent_id: incumbent.agent_id };
  }).immediate;

  /**
   * One transaction, because the `stopped` write and its `crashed` attention row
   * must land together or not at all.
   *
   * A no-op when tmux could not answer: `panes === null` is absence of evidence,
   * not evidence of death, and conflating the two once deleted ten live agents.
   */
  const reconcileLocal = database.transaction((world: LocalWorld): ReconcileSummary => {
    const summary: ReconcileSummary = { crashed: [], removed: [], attention_removed: [] };
    if (world.panes === null) return summary;
    const live = world.panes;
    const isAlive = world.isAlive ?? pidAlive;
    const now = world.now ?? Date.now();

    // Which panes already carry a crash we recorded. Read once, before any
    // write, so the loop below sees the state reconciliation started from.
    const alreadyCrashed = new Set(
      (selectAttention.all() as AttentionDbRow[])
        .filter((row) => row.kind === "crashed")
        .map((row) => row.pane),
    );

    for (const row of selectAgents.all() as AgentDbRow[]) {
      const pane = asPaneId(row.pane);
      if (!live.has(pane)) {
        deleteAgentByPane.run(row.pane);
        deleteAttentionForPane.run(row.pane);
        summary.removed.push(pane);
        continue;
      }
      if (isAlive(row.owner_pid)) continue;

      // The asymmetry below is the point. A dead RUNNING owner is an unreported
      // crash and must leave a durable trace. A dead STOPPED owner finished
      // normally, so its row is noise — but any `done` it raised is a fact a
      // human has not yet seen, so the attention stays.
      if (row.activity === "running") {
        setActivityByPane.run("stopped", now, row.pane);
        upsertAttention.run({
          pane: row.pane,
          kind: "crashed",
          message: "",
          source: "murmur",
          session: row.session,
          window: row.window,
          session_name: row.session_name,
          window_name: row.window_name,
          requested_at: now,
        });
        summary.crashed.push(pane);
      } else if (!alreadyCrashed.has(row.pane)) {
        deleteAgentByPane.run(row.pane);
        summary.removed.push(pane);
      }
      // A pane we already recorded a crash for keeps its agent row, and that is
      // the one place this deviates from a literal reading of the contract's
      // table -- which says a live pane with a dead STOPPED owner loses its row.
      // Taken literally, the second reconcile after a crash deletes the row the
      // first one had just marked `stopped`, so the crashed pane loses its
      // agent_name, workstream, role and cli one tick after the crash is
      // reported. That contradicts the contract's own idempotence requirement
      // ("running it again changes nothing") and it strips exactly the fields a
      // human needs to know WHICH agent died.
      //
      // The distinction the table is drawing is between an owner that finished
      // normally -- whose row is noise -- and one that died mid-run. The
      // `crashed` row we wrote is the record of which case this was, so it is
      // also the right thing to key on.
    }

    // Reaps attention for a pane that never had an agent row — an
    // attention-only codex pane whose window was closed. Nothing else would.
    for (const row of selectAttention.all() as AttentionDbRow[]) {
      const pane = asPaneId(row.pane);
      if (live.has(pane)) continue;
      deleteAttentionForPane.run(row.pane);
      if (!summary.attention_removed.includes(pane)) summary.attention_removed.push(pane);
    }

    return summary;
  }).immediate;

  /**
   * Both tables read at ONE point in time, or a pane can appear with an agent
   * and without the attention that was there when the agent was read.
   */
  const readLocalPanes = database.transaction((): SnapshotPane[] => {
    const agents = selectAgents.all() as AgentDbRow[];
    const attention = selectAttention.all() as AttentionDbRow[];
    const panes = new Map<string, SnapshotPane>();

    const locate = (row: AgentDbRow | AttentionDbRow): SnapshotPane => {
      const existing = panes.get(row.pane);
      if (existing) return existing;
      const created: SnapshotPane = {
        pane: asPaneId(row.pane),
        session: asSessionId(row.session),
        window: asWindowId(row.window),
        session_name: row.session_name,
        window_name: row.window_name,
        agent: null,
        attention: [],
      };
      panes.set(row.pane, created);
      return created;
    };

    for (const row of agents) locate(row).agent = toAgent(row);
    for (const row of attention) locate(row).attention.push(toAttention(row));

    for (const pane of panes.values()) pane.attention.sort(attentionOrder);
    return [...panes.values()].sort((left, right) => left.pane.localeCompare(right.pane));
  });

  function peerRecord(row: PeerDbRow): PeerRecord {
    let snapshot: Snapshot | null = null;
    if (row.snapshot !== null) {
      try {
        // Parsed leniently on the way OUT: it was validated on the way in, and
        // a read path must not throw. A stored document that no longer parses
        // reads as "no snapshot" and is left in place, not deleted.
        snapshot = JSON.parse(row.snapshot) as Snapshot;
      } catch {
        snapshot = null;
      }
    }
    return {
      name: row.name,
      target: row.target,
      host_id: row.host_id,
      display_name: row.display_name,
      snapshot,
      snapshot_at: row.snapshot_at,
      fetched_at: row.fetched_at,
      last_attempt_at: row.last_attempt_at,
      last_error: row.last_error,
      murmur_version: row.murmur_version,
      snapshot_version: row.snapshot_version,
    };
  }

  return {
    claimAgent,
    reconcileLocal,

    setActivity(update) {
      // Both key components are required, so a write from a REPLACED owner
      // matches nothing and returns false. That is not an error and must not be
      // retried: it means this process is no longer the owner of record, and the
      // correct response is silence.
      return (
        updateActivity.run({
          activity: update.activity,
          session: update.location.session,
          window: update.location.window,
          session_name: update.location.session_name,
          window_name: update.location.window_name,
          updated_at: update.now ?? Date.now(),
          agent_id: update.agent_id,
          owner_pid: update.owner_pid,
        }).changes === 1
      );
    },

    releaseAgent(release) {
      // Attention is deliberately NOT deleted: a `done` raised at settle must
      // survive the agent exiting, or completion becomes invisible the moment
      // the process quits.
      return deleteAgentOwned.run(release.agent_id, release.owner_pid).changes === 1;
    },

    requestAttention(request) {
      // `requested_at` is absent from the DO UPDATE list on purpose. Age means
      // "how long this has gone unmet", so a repeat must not reset the clock —
      // which also makes crash attention idempotent for free. Touches no
      // `agents` row, ever; there is no column here that could.
      upsertAttention.run({
        pane: request.location.pane,
        kind: request.kind,
        message: request.message,
        source: request.source,
        session: request.location.session,
        window: request.location.window,
        session_name: request.location.session_name,
        window_name: request.location.window_name,
        requested_at: request.now ?? Date.now(),
      });
    },

    acknowledgePane(pane) {
      // Every kind, one statement, no agent row touched: focusing a pane cannot
      // alter activity or owner metadata. This is the whole `murmur clear`
      // write path.
      return deleteAttentionForPane.run(pane).changes;
    },

    localPanes() {
      return readLocalPanes();
    },

    buildLocalSnapshot(identity, world) {
      // Reconcile first, which is what makes "a snapshot is authoritative"
      // true: absence from a successful snapshot means absence, so it must
      // never be produced from unreconciled rows. Two transactions rather than
      // one — a write transaction held open across the read would serialise
      // every focus hook on the machine behind an export.
      reconcileLocal(world);
      return {
        murmur_snapshot: 1,
        host_id: identity.host_id,
        display_name: identity.display_name,
        murmur_version: MURMUR_VERSION,
        generated_at: world.now ?? Date.now(),
        // Rule 3: an empty pane is readable locally but must not be published.
        panes: readLocalPanes().filter((pane) => pane.agent !== null || pane.attention.length > 0),
      };
    },

    peers() {
      return (database.prepare("SELECT * FROM peers ORDER BY name").all() as PeerDbRow[]).map(
        peerRecord,
      );
    },

    addPeer(name, target) {
      // Correcting a target must not discard the cache, so this updates only
      // the field the operator retyped.
      database
        .prepare(
          `INSERT INTO peers (name, target) VALUES (?, ?)
           ON CONFLICT(name) DO UPDATE SET target = excluded.target`,
        )
        .run(name, target);
    },

    removePeer(name) {
      return database.prepare("DELETE FROM peers WHERE name = ?").run(name).changes > 0;
    },

    replacePeerSnapshot(name, fetch) {
      if (!fetch.ok) {
        // Failure touches neither snapshot, snapshot_at nor fetched_at, so the
        // last-known document stands and the peer ages into `stale` on its own.
        database
          .prepare("UPDATE peers SET last_attempt_at = ?, last_error = ? WHERE name = ?")
          .run(fetch.at, fetch.error, name);
        return;
      }
      // Two clocks, and conflating them is how a freshly fetched three-hour-old
      // fact reads as new. `snapshot_at` is the PEER's clock (when it built the
      // document); `fetched_at` is OURS (when we reached it), and freshness is
      // computed from `fetched_at` only.
      database
        .prepare(
          `UPDATE peers
              SET snapshot = ?, snapshot_at = ?, fetched_at = ?, last_attempt_at = ?,
                  last_error = NULL, host_id = ?, display_name = ?,
                  murmur_version = ?, snapshot_version = ?
            WHERE name = ?`,
        )
        .run(
          JSON.stringify(fetch.snapshot),
          fetch.snapshot.generated_at,
          fetch.at,
          fetch.at,
          fetch.snapshot.host_id,
          fetch.snapshot.display_name,
          fetch.snapshot.murmur_version,
          fetch.snapshot.murmur_snapshot,
          name,
        );
    },

    close() {
      database.close();
    },
  };
}
