import { rmSync } from "node:fs";
import Database from "better-sqlite3";
import { ensureIdentity } from "./identity.js";
import { dbPath } from "./paths.js";
import type { Driver, Event, Peer } from "./types.js";

const DEFAULT_RETENTION_MS = 7 * 86_400_000;

/**
 * Local storage shape. Bump on any change to the events or peers tables.
 *
 * Distinct from `SCHEMA_VERSION` in export.ts, which versions the *wire*: a
 * node can change how it stores events without changing what it sends, and a
 * wire change should not throw away local history.
 */
export const STORE_VERSION = 2;

/**
 * Migration strategy: there isn't one. A version mismatch deletes the database
 * and starts again.
 *
 * This is only acceptable because nothing in events.db is authoritative or
 * irreplaceable. It is a bounded-retention observability log: remote events
 * re-sync from their authoring peer on the next collect, local agents re-report
 * on their next state change, and node identity deliberately lives in a
 * separate file. If anything durable is ever added here, this stops being safe
 * and a real migration is required.
 *
 * Peers survive, because they are the one thing a human typed. Watermarks are
 * reset with the events they indexed -- keeping them would skip the events the
 * new database no longer has -- and re-reading a peer from zero is free, since
 * ingest is idempotent.
 */
function resetIfStale(path: string): Peer[] {
  let salvaged: Peer[] = [];
  try {
    const existing = new Database(path, { fileMustExist: true });
    const version = (existing.pragma("user_version", { simple: true }) as number) ?? 0;
    if (version === STORE_VERSION) {
      existing.close();
      return salvaged;
    }
    try {
      salvaged = existing
        .prepare("SELECT name, target, host_id, display_name FROM peers")
        .all() as Peer[];
    } catch {
      // Old enough not to have the table, or unreadable. Nothing to save.
    }
    existing.close();
  } catch {
    // No database yet, or one too broken to open. Either way, recreate.
    return salvaged;
  }

  // -wal and -shm must go too: a stale sidecar against a fresh main file is a
  // documented way to corrupt sqlite.
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  return salvaged;
}

// The name fields are optional on the way in: a caller that has no name for a
// thing should not have to say `null` four times, and a non-tmux harness has
// none of them. They are non-optional on `Event` itself, so a reader never has
// to distinguish absent from null.
export type NewEvent = Omit<
  Event,
  "host_id" | "seq" | "ts" | "session_name" | "window_name" | "agent_name" | "pi_session"
> & {
  ts?: number;
  session_name?: string | null;
  window_name?: string | null;
  agent_name?: string | null;
  pi_session?: string | null;
};

type EventRow = Omit<Event, "synthetic" | "extra"> & {
  synthetic: number;
  extra: string;
};

function eventValues(event: Event): unknown[] {
  return [
    event.host_id,
    event.seq,
    event.ts,
    event.agent_id,
    event.session,
    event.window,
    event.pane,
    event.session_name,
    event.window_name,
    event.agent_name,
    event.pi_session,
    event.workstream,
    event.role,
    event.cli,
    event.driver,
    event.kind,
    event.state,
    event.message,
    event.pid,
    Number(event.synthetic),
    event.reason,
    JSON.stringify(event.extra),
  ];
}

function toEvent(row: EventRow): Event {
  return {
    ...row,
    driver: row.driver as Driver | null,
    synthetic: row.synthetic === 1,
    extra: JSON.parse(row.extra) as Record<string, unknown>,
  };
}

export interface Store {
  append(event: NewEvent): Event;
  ingest(events: Event[]): number;
  eventsSince(hostId: string, seq: number): Event[];
  allEvents(): Event[];
  /**
   * The most recent event for one agent, or null.
   *
   * Exists so the `clear` hook does not have to open its own SQLite handle and
   * write its own `ORDER BY seq DESC LIMIT 1`, which is what it used to do --
   * making "store is the only module touching SQL" false, and putting knowledge
   * of agent_id construction and event ordering in a CLI file where a schema
   * change would miss it. That path swallows its own errors, so the miss would
   * have been silent.
   */
  latestForAgent(hostId: string, agentId: string): Event | null;
  maxSeq(hostId: string): number;
  prune(horizonMs?: number): number;
  peers(): Peer[];
  /**
   * Drop every event for one agent from this node's replica.
   *
   * For a remote agent this is a replica eviction, not a claim about truth: the
   * authoring node still owns it, and a collect re-reads from the watermark if
   * it is still alive.
   */
  forgetAgent(agentId: string): number;
  forgetHost(hostId: string): number;
  upsertPeer(peer: Partial<Peer> & { name: string; target: string }): void;
  removePeer(name: string): boolean;
  close(): void;
}

export function openStore(): Store {
  const identity = ensureIdentity();
  const path = dbPath();
  const salvagedPeers = resetIfStale(path);
  const database = new Database(path);
  database.pragma("journal_mode = WAL");
  // Stated rather than relied on. better-sqlite3 already defaults this to 5s,
  // but WAL's one-writer-at-a-time rule plus a zero timeout is the difference
  // between a queued append and a lost event, and that is too load-bearing to
  // leave as a library default someone could change.
  database.pragma("busy_timeout = 5000");
  database.pragma(`user_version = ${STORE_VERSION}`);
  database.exec(`
    CREATE TABLE IF NOT EXISTS events (
      host_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      session TEXT NOT NULL,
      window TEXT NOT NULL,
      pane TEXT NOT NULL,
      session_name TEXT,
      window_name TEXT,
      agent_name TEXT,
      pi_session TEXT,
      workstream TEXT,
      role TEXT,
      cli TEXT,
      driver TEXT,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      message TEXT NOT NULL,
      pid INTEGER,
      synthetic INTEGER NOT NULL,
      reason TEXT NOT NULL,
      extra TEXT NOT NULL,
      PRIMARY KEY (host_id, seq)
    );
    CREATE INDEX IF NOT EXISTS events_agent_seq ON events (agent_id, seq);
    CREATE TABLE IF NOT EXISTS peers (
      name TEXT PRIMARY KEY,
      target TEXT NOT NULL,
      host_id TEXT,
      display_name TEXT,
      watermark INTEGER NOT NULL,
      fetched_at INTEGER,
      -- When a jump last proved this peer's tmux was not answering. Reader
      -- state, not an event: this node cannot author facts about another
      -- node's agents, and a jump is a local observation, not something the
      -- peer said. Cleared by the next successful collect.
      tmux_down_at INTEGER
    );
  `);

  // Additive migration: an existing peers table predates tmux_down_at.
  try {
    database.exec("ALTER TABLE peers ADD COLUMN tmux_down_at INTEGER");
  } catch {
    // Already present.
  }

  // Put back the peers the wipe took, at watermark 0 so the next collect
  // re-reads each one from the start.
  if (salvagedPeers.length > 0) {
    const restore = database.prepare(
      `INSERT OR IGNORE INTO peers (name, target, host_id, display_name, watermark, fetched_at)
       VALUES (?, ?, ?, ?, 0, NULL)`,
    );
    for (const peer of salvagedPeers) {
      restore.run(peer.name, peer.target, peer.host_id ?? null, peer.display_name ?? null);
    }
  }

  const eventColumns = `
      host_id, seq, ts, agent_id, session, window, pane,
      session_name, window_name, agent_name, pi_session,
      workstream, role, cli, driver, kind, state, message, pid,
      synthetic, reason, extra`;
  const eventPlaceholders = new Array(22).fill("?").join(", ");
  const insertEvent = database.prepare(
    `INSERT INTO events (${eventColumns}) VALUES (${eventPlaceholders})`,
  );
  const ingestEvent = database.prepare(
    `INSERT OR IGNORE INTO events (${eventColumns}) VALUES (${eventPlaceholders})`,
  );
  const selectMaxSeq = database.prepare(
    "SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE host_id = ?",
  );
  // `.immediate` rather than a plain (deferred) transaction, and it is the fix
  // that busy_timeout alone could not be.
  //
  // Both of these read the max seq and then write, so a deferred transaction
  // starts as a READER and tries to upgrade to a writer. When two do that at
  // once, the loser's snapshot is already out of date and SQLite fails it with
  // SQLITE_BUSY_SNAPSHOT immediately -- a timeout cannot help, because waiting
  // longer cannot make a stale snapshot fresh. `.immediate` takes the write
  // lock up front, so contenders queue on busy_timeout instead of failing.
  //
  // Measured with 8 concurrent appenders x 40 events: 5 of 8 writers failed
  // before, 0 fail after.
  const appendTransaction = database.transaction((event: NewEvent): Event => {
    const row = selectMaxSeq.get(identity.host_id) as { seq: number };
    const stored: Event = {
      ...event,
      host_id: identity.host_id,
      seq: row.seq + 1,
      ts: event.ts ?? Date.now(),
      session_name: event.session_name ?? null,
      window_name: event.window_name ?? null,
      agent_name: event.agent_name ?? null,
      pi_session: event.pi_session ?? null,
    };
    insertEvent.run(...eventValues(stored));
    return stored;
  });
  const append = appendTransaction.immediate;
  const ingestTransaction = database.transaction((events: Event[]): number => {
    let inserted = 0;
    for (const event of events) inserted += ingestEvent.run(...eventValues(event)).changes;
    return inserted;
  });
  const ingest = ingestTransaction.immediate;

  return {
    append,
    ingest,
    eventsSince(hostId, seq) {
      const rows = database
        .prepare("SELECT * FROM events WHERE host_id = ? AND seq > ? ORDER BY seq")
        .all(hostId, seq) as EventRow[];
      return rows.map(toEvent);
    },
    allEvents() {
      const rows = database
        .prepare("SELECT * FROM events ORDER BY ts, host_id, seq")
        .all() as EventRow[];
      return rows.map(toEvent);
    },
    latestForAgent(hostId, agentId) {
      const row = database
        .prepare(
          `SELECT * FROM events
            WHERE host_id = ? AND agent_id = ?
            ORDER BY seq DESC LIMIT 1`,
        )
        .get(hostId, agentId) as EventRow | undefined;
      return row ? toEvent(row) : null;
    },
    maxSeq(hostId) {
      return (selectMaxSeq.get(hostId) as { seq: number }).seq;
    },
    prune(horizonMs = Number(process.env.MURMUR_RETENTION_MS ?? DEFAULT_RETENTION_MS)) {
      return database
        .prepare(`
          DELETE FROM events
           WHERE ts < ?
             AND (host_id, seq) NOT IN (
               SELECT host_id, seq FROM (
                 SELECT host_id, seq,
                        ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY ts DESC, seq DESC) rn
                   FROM events
               ) WHERE rn = 1
             )
        `)
        .run(Date.now() - horizonMs).changes;
    },
    peers() {
      return database.prepare("SELECT * FROM peers ORDER BY name").all() as Peer[];
    },
    forgetAgent(agentId) {
      return database.prepare("DELETE FROM events WHERE agent_id = ?").run(agentId).changes;
    },
    forgetHost(hostId) {
      // Every replicated row for one origin node. Only ever called about a
      // REMOTE host: the local host's rows are this node's own authorship and
      // the retention horizon owns them.
      return database.prepare("DELETE FROM events WHERE host_id = ?").run(hostId).changes;
    },
    upsertPeer(peer) {
      const current = database.prepare("SELECT * FROM peers WHERE name = ?").get(peer.name) as
        | Peer
        | undefined;
      database
        .prepare(`
          INSERT INTO peers (name, target, host_id, display_name, watermark, fetched_at, tmux_down_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET
            target = excluded.target,
            host_id = excluded.host_id,
            display_name = excluded.display_name,
            watermark = excluded.watermark,
            fetched_at = excluded.fetched_at,
            tmux_down_at = excluded.tmux_down_at
        `)
        .run(
          peer.name,
          peer.target,
          peer.host_id !== undefined ? peer.host_id : (current?.host_id ?? null),
          peer.display_name !== undefined ? peer.display_name : (current?.display_name ?? null),
          peer.watermark !== undefined ? peer.watermark : (current?.watermark ?? 0),
          peer.fetched_at !== undefined ? peer.fetched_at : (current?.fetched_at ?? null),
          peer.tmux_down_at !== undefined ? peer.tmux_down_at : (current?.tmux_down_at ?? null),
        );
    },
    removePeer(name) {
      // Drops the peer and its watermark. Replicated events stay: they are
      // real history authored elsewhere, and the retention horizon already
      // ages them out. Re-adding the peer re-syncs from zero, which ingest
      // makes free.
      return database.prepare("DELETE FROM peers WHERE name = ?").run(name).changes > 0;
    },
    close() {
      database.close();
    },
  };
}
