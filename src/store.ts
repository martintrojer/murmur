import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { NodeIdentity } from "./identity.js";
import type { PaneId } from "./ids.js";
import { asPaneId, asSessionId, asWindowId } from "./ids.js";
import { pidAlive } from "./mux.js";
import { dbPath } from "./paths.js";
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
 * ONE version strategy: a mismatch salvages the peer names and targets a human
 * typed, deletes the file, and recreates the schema. No ALTER TABLE anywhere, so
 * there is no additive path to forget to use.
 */
const SCHEMA_USER_VERSION = 3;

/**
 * How long to wait for another process's reset before stealing its lock.
 *
 * A reset is a handful of file operations, so a lock held longer than this is a
 * dead holder rather than a slow one. Matches `busy_timeout`, since both bound
 * "wait for another process to finish writing".
 */
const RESET_LOCK_TIMEOUT_MS = 5_000;

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
 * This interface is CLOSED: no `append`, no `ingest`, no log read, no partial-row
 * update, and no local read other than `localPanes`. Each of those shapes lets a
 * writer say something it has no standing to say, and each cost a shipped bug.
 * Attention methods take no agent identity, which is what makes "a notifier
 * cannot corrupt an agent row" structural.
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
 * Hold an exclusive lock beside the database while `work` runs, and return its
 * result.
 *
 * Serialises the salvage-and-delete sequence across processes. Best effort in
 * both directions, deliberately: a lock that could make murmur refuse to start
 * would be worse than the race it prevents, so a lock held implausibly long is
 * stolen and any inability to lock falls through to doing the work anyway.
 *
 * `wx` is atomic create-or-fail, which is what makes the file a lock. The wait
 * is a synchronous spin because every caller of `openStore` is synchronous --
 * `Atomics.wait` needs a SharedArrayBuffer and buys nothing here, since the
 * critical section is a few file operations and contention is a once-per-
 * upgrade burst rather than a steady state.
 */
function withResetLock<T>(path: string, work: () => T): T {
  const lock = `${path}.reset-lock`;
  const deadline = Date.now() + RESET_LOCK_TIMEOUT_MS;
  let held = false;
  while (!held) {
    try {
      closeSync(openSync(lock, "wx"));
      held = true;
    } catch {
      // Still held by someone else. Keep trying until the deadline, then treat
      // the holder as dead -- a lock this old means a process died mid-reset,
      // and hanging a status-bar tick forever is worse than stealing it.
      if (Date.now() < deadline) continue;
      try {
        rmSync(lock, { force: true });
      } catch {
        break; // Cannot even remove it; proceed unlocked.
      }
    }
  }
  try {
    return work();
  } finally {
    if (held) {
      try {
        rmSync(lock, { force: true });
      } catch {
        // Left behind; the next opener's timeout steals it.
      }
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

/**
 * Whether the file at `path` must be thrown away and recreated.
 *
 * Three outcomes collapse into two answers, and getting that wrong was a bug:
 * a file that opens and matches needs nothing, a file that opens and disagrees
 * needs a reset, and a file murmur CANNOT READ needs one just as much.
 *
 * The last case is the subtle one. better-sqlite3's constructor does not touch
 * the file, so a corrupt `state.db` constructs fine and the first `pragma` is
 * what throws. That throw used to land in a catch that returned false -- "no
 * reset needed" for precisely the file that needed one -- and every command
 * that opened the store then died on the same pragma with a raw SqliteError,
 * including the status bar on every tick and every focus hook. The only
 * recovery was deleting the file by hand.
 *
 * Resetting is the right answer because nothing here is history: the store
 * holds current state only, every fact in it is re-derived by the next collect
 * or the next claim, so discarding an unusable file costs nothing. That is the
 * same argument the version-mismatch path already makes.
 *
 * A missing file is the one case that is NOT a reset: there is nothing to
 * delete, and `openStore` creates the schema anyway.
 */
function needsReset(path: string): boolean {
  let existing: Database.Database;
  try {
    existing = new Database(path, { fileMustExist: true });
  } catch {
    // No file yet. Nothing to remove, and the schema is created below.
    return false;
  }
  try {
    return (
      ((existing.pragma("user_version", { simple: true }) as number) ?? 0) !== SCHEMA_USER_VERSION
    );
  } catch {
    // Opened but unreadable: not a database, or damaged past the header. This
    // is the case that used to answer `false` and crash every later command.
    return true;
  } finally {
    existing.close();
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

  // Salvage, decide and delete under ONE lock, because deleting the database
  // FILE is the operation SQLite cannot serialise for us: there is no handle to
  // hold a transaction on across removing the file it lives in.
  //
  // Unlocked, this lost data a person typed, reproducibly -- peer rows vanished
  // in 6 of 12 concurrent upgrade runs measured against `dist/`, and still 4 of
  // 12 once the schema step alone was serialised. Each process salvaged, each
  // agreed a reset was needed, and then each deleted the file, `-wal` included,
  // so one `rmSync` destroyed the database another had just rebuilt and took
  // its salvage with it.
  //
  // Peers are the only rows worth this trouble: every other fact is re-observed
  // within a tick, while a name and target cannot be re-derived from anything.
  // The whole sequence under ONE lock: salvage, delete, rebuild. Deleting the
  // database FILE is the operation SQLite cannot serialise for us, since there
  // is no handle to hold a transaction on across removing the file it lives in.
  //
  // Unlocked, this lost data a person typed, reproducibly: peer rows vanished in
  // 6 of 12 concurrent upgrade runs measured against `dist/`. Each process
  // salvaged, each agreed a reset was needed, and then each deleted the file,
  // `-wal` included, so one `rmSync` destroyed the database another had just
  // rebuilt and took its salvage with it.
  //
  // Delete and rebuild must be in the SAME critical section, which took three
  // attempts to get right: serialising the delete alone still lost the peer
  // about 1 run in 25, because the winner dropped the lock with the file gone
  // and the schema not yet written, and whoever entered that window salvaged
  // nothing from a database that did not exist yet. The invariant is that no
  // other process ever observes the store mid-rebuild.
  //
  // Peers are the only rows worth this trouble: every other fact is re-observed
  // within a tick, while a name and target cannot be re-derived from anything.
  const database = withResetLock(path, () => {
    const salvaged = salvagePeers(path);
    if (needsReset(path)) {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    }

    const opened = new Database(path);
    opened.pragma("journal_mode = WAL");
    opened.pragma("busy_timeout = 5000");

    // Transactional and `.immediate` even while holding the file lock, because
    // that lock is best effort by design -- it can be stolen after a timeout,
    // and failing to take it falls through to doing the work anyway -- so this
    // has to stay correct without it.
    //
    // `.immediate` for the same reason `claimAgent` uses it, in the same terms:
    // this reads `user_version` and then writes, so a deferred transaction
    // starts as a READER and must upgrade, which fails the loser with
    // SQLITE_BUSY_SNAPSHOT rather than making it wait. Taking the write lock up
    // front means a second process blocks on `busy_timeout` and then finds the
    // version already current, so it creates nothing. Measured against `dist/`:
    // 23 failures over 20 trials of 8 concurrent opens, against 0 after.
    //
    // The re-read INSIDE the transaction is the other half. Without it the
    // loser would hold the lock and still act on the version it read before
    // waiting for it, which is the original bug with extra steps.
    opened
      .transaction(() => {
        const version = (opened.pragma("user_version", { simple: true }) as number) ?? 0;
        if (version === SCHEMA_USER_VERSION) return;
        opened.exec(SCHEMA);
        opened.pragma(`user_version = ${SCHEMA_USER_VERSION}`);
        // Re-inserted with every OBSERVED column null: a salvaged peer has no
        // snapshot and has never been fetched, and saying otherwise would
        // render a never-reached host as fresh.
        const restore = opened.prepare("INSERT OR IGNORE INTO peers (name, target) VALUES (?, ?)");
        for (const peer of salvaged) restore.run(peer.name, peer.target);
      })
      .immediate();

    // Forced out of the WAL before the lock drops, so the rebuilt rows live in
    // the database file itself. Otherwise the salvage sits in `-wal` and the
    // next process to decide on a reset deletes it -- the original bug, one
    // step later.
    opened.pragma("wal_checkpoint(TRUNCATE)");
    return opened;
  });

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
   * This reads the incumbent row and then writes, so a deferred transaction
   * starts as a READER and must upgrade. Two at once fail the loser with
   * SQLITE_BUSY_SNAPSHOT, which no busy_timeout can fix -- waiting cannot make a
   * stale snapshot fresh. Measured at 5 of 8 concurrent writers failing.
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
      // A pane already recorded as crashed keeps its agent row, the one place
      // this departs from a literal reading of the contract's table (which says
      // a live pane with a dead STOPPED owner loses its row). Taken literally,
      // the second reconcile deletes the row the first just marked `stopped`, so
      // the crashed pane loses agent_name, workstream, role and cli one tick
      // after the crash -- contradicting the contract's own idempotence rule and
      // stripping exactly the fields that say WHICH agent died.
      //
      // The table's real distinction is between an owner that finished normally,
      // whose row is noise, and one that died mid-run. The `crashed` row is the
      // record of which case this was, so it is the right thing to key on.
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
        // Rule 3: a pane with no agent and no attention must not be published.
        // A no-op against today's `readLocalPanes`, which builds a pane entry
        // only from a row and so cannot produce an empty one -- kept because the
        // rule belongs to the DOCUMENT, and the validator rejects such an entry
        // outright. Without it, one narrowing of the local read would make this
        // node reachable-but-broken on every peer that collects it, and the
        // symptom would show up on the other machines.
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
