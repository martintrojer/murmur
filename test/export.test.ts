import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { eventFromWire, exportJsonl, SCHEMA_VERSION } from "../src/export.js";
import { openStore, type Store } from "../src/store.js";
import type { Event } from "../src/types.js";

const stores: Store[] = [];
let s: Store;

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-export-"));
  s = openStore();
  stores.push(s);
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function localEvent(partial: Partial<Omit<Event, "host_id" | "seq" | "ts">> = {}) {
  return {
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
    state: "done",
    message: "",
    pid: null,
    synthetic: false,
    reason: "",
    extra: {},
    ...partial,
  };
}

test("export emits an envelope then events after the watermark", () => {
  s.append(localEvent());
  s.append(localEvent());
  s.append(localEvent());

  const lines = exportJsonl(s, 1, () => true)
    .trim()
    .split("\n");

  expect(JSON.parse(lines[0] ?? "").schema_version).toBe(SCHEMA_VERSION);
  expect(lines.slice(1).map((line) => JSON.parse(line).seq)).toEqual([2, 3]);
});

test("export synthesizes crashed for a dead working pid", () => {
  s.append(localEvent({ agent_id: "a", state: "working", pid: 4242 }));

  const events = exportJsonl(s, 0, () => false)
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => JSON.parse(line));
  const last = events.at(-1);

  expect(last.state).toBe("crashed");
  expect(last.synthetic).toBe(true);
  expect(last.reason).toBe("pid_gone");
});

test("export checks pid liveness only for local events", () => {
  const pid = 4242;
  const local = s.append(localEvent({ agent_id: "local", state: "working", pid }));
  s.ingest([
    {
      ...local,
      host_id: "remote-host",
      seq: 1,
      agent_id: "remote",
    },
  ]);

  exportJsonl(s, 0, () => false);

  expect(
    s
      .allEvents()
      .filter((event) => event.synthetic)
      .map(({ agent_id, host_id, reason, state }) => ({ agent_id, host_id, reason, state })),
  ).toEqual([{ agent_id: "local", host_id: local.host_id, reason: "pid_gone", state: "crashed" }]);
  expect(
    s
      .allEvents()
      .filter((event) => event.agent_id === "remote")
      .map((event) => event.state),
  ).toEqual(["working"]);
});

test("extra survives an export/ingest round trip", () => {
  s.append(localEvent({ driver: "orchestrated", extra: { future_field: { nested: [1, 2] } } }));
  const wire = JSON.parse(
    exportJsonl(s, 0, () => true)
      .trim()
      .split("\n")[1] ?? "",
  );

  expect(wire.future_field).toEqual({ nested: [1, 2] });
  expect(wire.extra).toBeUndefined();
  expect(wire.driver).toBe("orchestrated");
  const olderWire = { ...wire };
  delete olderWire.driver;
  expect(eventFromWire(olderWire).driver).toBeNull();

  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-export-roundtrip-"));
  const destination = openStore();
  stores.push(destination);
  destination.ingest([eventFromWire(wire)]);

  expect(destination.allEvents()[0]?.extra).toEqual({ future_field: { nested: [1, 2] } });
  expect(destination.allEvents()[0]?.driver).toBe("orchestrated");
});

test("re-export reproduces an unknown event line byte for byte", () => {
  const extra = {
    future_object: { nested: { value: "kept" } },
    future_array: [{ object: true }, ["nested", "array"]],
    host_id: "must-not-override-known-fields",
  };
  const stored = s.append(localEvent({ kind: "future_kind", extra }));
  const first =
    exportJsonl(s, 0, () => true)
      .trim()
      .split("\n")[1] ?? "";
  expect(JSON.parse(first).host_id).toBe(stored.host_id);

  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-export-reexport-"));
  writeFileSync(
    join(process.env.MURMUR_STATE_DIR, "identity.json"),
    JSON.stringify({ host_id: stored.host_id, display_name: "destination" }),
  );
  const destination = openStore();
  stores.push(destination);
  destination.ingest([eventFromWire(JSON.parse(first) as Record<string, unknown>)]);

  const second =
    exportJsonl(destination, 0, () => true)
      .trim()
      .split("\n")[1] ?? "";
  expect(second).toBe(first);
});
