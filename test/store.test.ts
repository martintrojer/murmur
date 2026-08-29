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
