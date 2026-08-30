import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  clearDeadWindows,
  eventFromWire,
  exportJsonl,
  reapDeadAgents,
  SCHEMA_VERSION,
} from "../src/export.js";
import { asPaneId, asSessionId, asWindowId, type PaneId } from "../src/ids.js";
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
    session: asSessionId("session"),
    window: asWindowId("window"),
    pane: asPaneId("pane"),
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

test("an agent whose window is gone and which already said cleared is dropped", () => {
  // Two correct rules met and leaked. Retention keeps the newest event per
  // agent forever so a long-idle agent does not vanish from the list; and
  // clearDeadWindows only ever CONVERTED a live row to `cleared`, skipping one
  // that was already cleared because there was nothing to supersede. So a dead
  // agent's final `cleared` was protected by pruning and removed by nothing.
  //
  // Observed: four crew rows on the author's machine outlived their tmux
  // windows indefinitely, visible under --all forever, and the only way to get
  // rid of them was the manual `del` key. A window tmux says is gone needs no
  // human judgement, so it should not need a keystroke.
  s.append(localEvent({ agent_id: "dead", pane: asPaneId("%gone"), state: "cleared" }));
  s.append(localEvent({ agent_id: "alive", pane: asPaneId("%here"), state: "cleared" }));
  const hostId = s.allEvents()[0]?.host_id ?? "";

  clearDeadWindows(s, hostId, new Set([asWindowId("@w")]), new Set([asPaneId("%here")]));

  const remaining = new Set(s.allEvents().map((event) => event.agent_id));
  expect(remaining.has("dead")).toBe(false);
  // A live window is untouched, however long it has been idle.
  expect(remaining.has("alive")).toBe(true);
});

test("an unacknowledged state on a dead window is superseded, never deleted", () => {
  // The narrowness that makes the deletion safe. blocked, done and crashed are
  // facts a human has not seen yet, and sweeping them away because the window
  // closed would hide exactly the failures this tool exists to surface -- an
  // agent that died mid-task would simply disappear. They become a synthetic
  // `cleared` instead, which keeps the history and the reason.
  for (const state of ["blocked", "done", "crashed"]) {
    s.append(localEvent({ agent_id: `dead-${state}`, pane: asPaneId(`%gone-${state}`), state }));
  }
  const hostId = s.allEvents()[0]?.host_id ?? "";

  clearDeadWindows(s, hostId, new Set([asWindowId("@w")]), new Set([asPaneId("%here")]));

  for (const state of ["blocked", "done", "crashed"]) {
    const events = s.allEvents().filter((event) => event.agent_id === `dead-${state}`);
    expect(events.length).toBeGreaterThan(1);
    expect(events.at(-1)).toMatchObject({
      state: "cleared",
      synthetic: true,
      reason: "window_gone",
    });
  }
});

test("housekeeping removes dead rows but authors nothing", () => {
  // Why the delete half is callable on its own. clearDeadWindows ran only from
  // `export`, which happens when a PEER asks over ssh -- so a node with no
  // peers reaped never, which is the everyday single-machine case. Housekeeping
  // now runs from `collect`, on every invocation.
  //
  // It must not author, though: synthesising a `cleared` is an authorship
  // decision that belongs with crash synthesis in export.
  s.append(localEvent({ agent_id: "dead", pane: asPaneId("%gone"), state: "cleared" }));
  s.append(localEvent({ agent_id: "blocked", pane: asPaneId("%gone2"), state: "blocked" }));

  const before = s.allEvents().length;
  reapDeadAgents(s, new Set<PaneId>());
  const after = s.allEvents();

  expect(after.some((event) => event.agent_id === "dead")).toBe(false);
  // The blocked row is left exactly as it was: not deleted, and not superseded.
  const blocked = after.filter((event) => event.agent_id === "blocked");
  expect(blocked).toHaveLength(1);
  expect(blocked[0]?.state).toBe("blocked");
  expect(after.length).toBeLessThan(before);
});

test("an agent whose PANE is alive survives, even if its window id is stale", () => {
  // The regression this pins, and it was severe: the sweep keyed on the window
  // id, which goes stale routinely. A pane keeps its id across move-pane,
  // break-pane, and a window being closed and reopened -- verified against real
  // tmux, where after move-pane the pane id was unchanged and the old window id
  // had vanished. Since `agent_id` is `host:pane`, the window on an agent's last
  // event is simply not evidence about whether the agent exists.
  //
  // Ten live pi agents were deleted from the author's store in one sweep: 13
  // panes carried murmur's badge and only 3 still had events.
  s.append(
    localEvent({
      agent_id: "moved",
      pane: asPaneId("%7"),
      window: asWindowId("@long-gone"),
      state: "cleared",
    }),
  );

  reapDeadAgents(s, new Set([asPaneId("%7")]));

  expect(s.allEvents().some((event) => event.agent_id === "moved")).toBe(true);
});

test("a sweep is abandoned when tmux cannot answer", () => {
  // null means "could not ask", which must never be read as "nothing exists".
  // Treating it as an empty set would delete every cleared agent on the host
  // the moment tmux was briefly unreachable.
  s.append(localEvent({ agent_id: "safe", pane: asPaneId("%1"), state: "cleared" }));

  reapDeadAgents(s, null);

  expect(s.allEvents().some((event) => event.agent_id === "safe")).toBe(true);
});
