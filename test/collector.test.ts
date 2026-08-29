import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { Channel } from "../src/channel.js";
import { collect } from "../src/collector.js";
import { openStore, type Store } from "../src/store.js";
import type { Event } from "../src/types.js";

const stores: Store[] = [];
let store: Store;

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-collector-"));
  store = openStore();
  stores.push(store);
});

afterEach(() => {
  for (const opened of stores.splice(0)) opened.close();
});

function event(seq: number, hostId = "remote-host"): Event {
  return {
    host_id: hostId,
    seq,
    ts: Date.now() + seq,
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
  };
}

function jsonl(events: Event[], hostId = "remote-host"): string {
  return [
    JSON.stringify({
      schema_version: 1,
      host_id: hostId,
      display_name: "Remote",
      exported_at: 1_000,
    }),
    ...events.map((item) => JSON.stringify(item)),
  ].join("\n");
}

test("collect ingests and advances the watermark", async () => {
  store.upsertPeer({ name: "dev", target: "dev.example" });
  const channel: Channel = {
    exec: async (target, argv) => {
      expect(target).toBe("dev.example");
      expect(argv).toEqual(["murmur", "export", "--since", "0"]);
      return jsonl([event(1), event(2)]);
    },
  };

  await expect(collect(store, channel, 5_000)).resolves.toEqual([
    { peer: "dev", ok: true, ingested: 2 },
  ]);
  expect(store.allEvents()).toHaveLength(2);
  expect(store.peers()[0]).toMatchObject({
    name: "dev",
    host_id: "remote-host",
    display_name: "Remote",
    watermark: 2,
    fetched_at: 5_000,
  });
});

test("a failing peer does not throw and leaves fetched_at stale", async () => {
  store.upsertPeer({ name: "dev", target: "dev", fetched_at: 123 });
  store.upsertPeer({ name: "prod", target: "prod" });
  const channel: Channel = {
    exec: async (target) => {
      if (target === "dev") throw new Error("authentication required");
      return jsonl([event(1)]);
    },
  };

  const result = await collect(store, channel, 5_000);

  expect(result).toEqual([
    { peer: "dev", ok: false, ingested: 0, error: "authentication required" },
    { peer: "prod", ok: true, ingested: 1 },
  ]);
  expect(store.peers()[0]?.fetched_at).toBe(123);
  expect(store.peers()[1]?.fetched_at).toBe(5_000);
});

test("a second collect with no new events is a no-op", async () => {
  store.upsertPeer({ name: "dev", target: "dev" });
  const since: string[] = [];
  const channel: Channel = {
    exec: async (_target, argv) => {
      since.push(argv.at(-1) ?? "");
      return since.length === 1 ? jsonl([event(1), event(2)]) : jsonl([]);
    },
  };

  expect(await collect(store, channel, 5_000)).toEqual([{ peer: "dev", ok: true, ingested: 2 }]);
  expect(await collect(store, channel, 6_000)).toEqual([{ peer: "dev", ok: true, ingested: 0 }]);
  expect(since).toEqual(["0", "2"]);
  expect(store.allEvents()).toHaveLength(2);
  expect(store.peers()[0]?.watermark).toBe(2);
});

test("host_id on ingested rows is the origin, not the peer name", async () => {
  store.upsertPeer({ name: "dev", target: "dev" });
  const channel: Channel = { exec: async () => jsonl([event(1, "H")], "H") };

  await collect(store, channel);

  expect(store.allEvents()[0]?.host_id).toBe("H");
});

test("an empty peer list does nothing and touches no channel", async () => {
  let calls = 0;
  const spy: Channel = {
    exec: async () => {
      calls += 1;
      return "";
    },
  };

  await expect(collect(store, spy)).resolves.toEqual([]);
  expect(calls).toBe(0);
});

test("new events clear a tmux_down mark, an empty export does not", async () => {
  // The race: a jump proves the peer's tmux is down, then the host comes back.
  // The log settles it — but only a real event counts. A successful export
  // proves the murmur binary ran, which it does happily on a host whose tmux
  // server is gone; treating that as recovery is what let a dead bubba read as
  // healthy for three hours.
  const store = openStore();
  store.upsertPeer({ name: "p", target: "p", host_id: "H", tmux_down_at: 1_000 });

  const empty: Channel = { exec: async () => jsonl([], "H") };
  await collect(store, empty);
  expect(store.peers()[0]?.tmux_down_at).toBe(1_000);

  const withEvent: Channel = { exec: async () => jsonl([event(1, "H")], "H") };
  await collect(store, withEvent);
  expect(store.peers()[0]?.tmux_down_at).toBeNull();
});
