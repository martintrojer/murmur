import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openStore, type Store } from "../src/store.js";
import type { Event } from "../src/types.js";

const stores: Store[] = [];

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-store-"));
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function store(): Store {
  const opened = openStore();
  stores.push(opened);
  return opened;
}

function remoteEvent(partial: Partial<Event> = {}): Event {
  return {
    host_id: "remote-host",
    seq: 1,
    ts: Date.now(),
    agent_id: "agent",
    session: "session",
    window: "window",
    pane: "pane",
    session_name: null,
    window_name: null,
    agent_name: null,
    pi_session: null,
    workstream: null,
    role: null,
    cli: null,
    driver: null,
    kind: "state",
    state: "working",
    message: "",
    pid: null,
    synthetic: false,
    reason: "",
    extra: {},
    ...partial,
  };
}

test("ingest is idempotent on (host_id, seq)", () => {
  const s = store();
  const event = remoteEvent({ host_id: "H", seq: 1 });

  expect(s.ingest([event])).toBe(1);
  expect(s.ingest([event])).toBe(0);
  expect(s.allEvents()).toHaveLength(1);
});

test("ingest inserts only the new portion of overlapping batches", () => {
  const s = store();
  const events = Array.from({ length: 8 }, (_, index) =>
    remoteEvent({ host_id: "H", seq: index + 1 }),
  );

  expect(s.ingest(events.slice(0, 5))).toBe(5);
  expect(s.ingest(events.slice(2))).toBe(3);
  expect(s.allEvents()).toHaveLength(8);
  expect(s.allEvents().map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

test("unknown fields and kinds round-trip verbatim", () => {
  const s = store();
  const event = remoteEvent({
    host_id: "H",
    seq: 1,
    kind: "future_kind",
    extra: { wat: [1, 2] },
  });

  s.ingest([event]);

  expect(s.eventsSince("H", 0)).toEqual([event]);
});

test.each([
  [1, 2],
  [2, 1],
])("prune breaks equal timestamp ties by sequence when inserted as %s then %s", (first, second) => {
  const s = store();
  const old = Date.now() - 30 * 86_400_000;
  const events = [
    remoteEvent({ host_id: "H", seq: first, agent_id: "a", ts: old }),
    remoteEvent({ host_id: "H", seq: second, agent_id: "a", ts: old }),
  ];
  s.ingest(events);

  s.prune(7 * 86_400_000);

  expect(s.allEvents().map((event) => event.seq)).toEqual([2]);
});

test("prune keeps the newest event per agent", () => {
  const s = store();
  const old = Date.now() - 30 * 86_400_000;
  s.ingest([
    remoteEvent({ host_id: "H", seq: 1, agent_id: "a", ts: old }),
    remoteEvent({ host_id: "H", seq: 2, agent_id: "a", ts: old + 1 }),
    remoteEvent({ host_id: "H", seq: 3, agent_id: "b", ts: old }),
  ]);

  s.prune(7 * 86_400_000);

  expect(
    s
      .allEvents()
      .map((event) => event.seq)
      .sort(),
  ).toEqual([2, 3]);
});

test("concurrent writers do not lose events to lock contention", async () => {
  // Observed, not hypothetical: an agent on the author's machine stopped
  // reporting mid-session because its append hit SQLITE_BUSY. Eight agents on
  // one box is the ordinary case here, and every failed append is a dropped
  // event -- the extension catches, drops its handle and moves on, so the
  // agent's state silently stops matching reality.
  //
  // Two separate causes, and the first fix did not address the second:
  //
  //   busy_timeout   a second writer used to fail INSTANTLY instead of waiting
  //   .immediate     append reads max(seq) then writes, so a deferred
  //                  transaction starts as a reader and upgrades. Two doing
  //                  that at once fails the loser with SQLITE_BUSY_SNAPSHOT,
  //                  which no timeout can fix -- waiting cannot refresh a
  //                  stale snapshot.
  //
  // Real processes, not threads: better-sqlite3 is synchronous, so separate
  // OS processes are the only way to contend for the lock the way agents do.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { existsSync } = await import("node:fs");
  const run = promisify(execFile);
  const stateDir = process.env.MURMUR_STATE_DIR ?? "";

  // The workers are separate PROCESSES, which is the only way to contend for a
  // SQLite lock the way real agents do -- better-sqlite3 is synchronous, so
  // nothing in one process can overlap. That means they import the built
  // artifact rather than src (whose `.js` specifiers need the build anyway).
  //
  // Stated as a skip rather than left to fail confusingly: this test failed
  // once mid-mutation-run because dist was being rebuilt underneath it, which
  // looked like flakiness in the code under test.
  const entry = join(process.cwd(), "dist", "index.js");
  if (!existsSync(entry)) {
    console.warn("skipping concurrency test: dist/index.js missing, run npm run build");
    return;
  }

  // Seed the identity once, so the workers race on appends rather than on
  // creating identity.json.
  openStore().close();

  const writer = `
    import { openStore } from "${entry}";
    const tag = process.argv[2];
    const store = openStore();
    for (let i = 0; i < 25; i += 1) {
      store.append({ agent_id: "H:%" + tag, session: "$0", window: "@" + tag,
        pane: "%" + tag, session_name: null, window_name: null,
        agent_name: null, pi_session: null, workstream: null, role: null,
        cli: "pi", driver: "human", kind: "state", state: "working",
        message: "", pid: 1, synthetic: false, reason: "", extra: {} });
    }
    store.close();
  `;

  const results = await Promise.allSettled(
    [1, 2, 3, 4, 5, 6].map((tag) =>
      run(process.execPath, ["--input-type=module", "--eval", writer, "--", String(tag)], {
        env: { ...process.env, MURMUR_STATE_DIR: stateDir },
      }),
    ),
  );

  // Every writer completed. Before the fix, most rejected with SQLITE_BUSY.
  const rejected = results.filter((result) => result.status === "rejected");
  expect(rejected.map((r) => String((r as PromiseRejectedResult).reason).slice(0, 120))).toEqual(
    [],
  );

  const store = openStore();
  stores.push(store);
  const events = store.allEvents();

  // Nothing lost, and no seq reused: a duplicate seq would silently overwrite
  // on a peer, since (host_id, seq) is the primary key ingest dedupes on.
  expect(events).toHaveLength(6 * 25);
  expect(new Set(events.map((event) => event.seq)).size).toBe(6 * 25);
});
