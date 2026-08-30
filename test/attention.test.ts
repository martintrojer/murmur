import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, expect, test } from "vitest";
import { clearPane } from "../src/cli/clear.js";
import { runNotify } from "../src/cli/notify.js";
import { createIdentity } from "../src/identity.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { dbPath } from "../src/paths.js";
import { openStore, type Store } from "../src/store.js";
import type { AgentMeta, Location } from "../src/types.js";
import { renderState } from "../src/view.js";
import { fakeMux } from "./helpers/fake-mux.js";

/**
 * Attention as an INDEPENDENT channel, asserted through the two commands that
 * write it rather than through the store alone.
 *
 * test/store.test.ts already proves `requestAttention` and `acknowledgePane`
 * cannot address an agent. That is the schema's claim. This file makes the
 * claim about the SHIPPED PATHS: `murmur notify` and `murmur clear` are what
 * ran on panes %250-%252, they resolve their own location, they open their own
 * store handle, and it was their composition -- notify then focus, against a
 * live owner -- that nulled agent_name, workstream, role and driver. A store
 * that cannot say the wrong thing is only half the guarantee if a caller can
 * still reach a wider write.
 *
 * Every assertion reads the `agents` table COLUMN BY COLUMN out of SQLite,
 * because `localPanes()` deliberately omits `owner_pid` and could not show a
 * corrupted one.
 */

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-attention-"));
  createIdentity("here");
});

function location(pane = "%250", window = "@1"): Location {
  return {
    session: asSessionId("$0"),
    window: asWindowId(window),
    pane: asPaneId(pane),
    session_name: "work",
    window_name: "worker-1",
  };
}

const META: AgentMeta = {
  agent_name: "worker-1",
  pi_session: "01JQ",
  workstream: "murmur",
  role: "implementer",
  cli: "pi",
  driver: "orchestrated",
};

/** A tmux that puts the caller in `pane`, with `panes` as the window's panes. */
function inPane(pane = "%250", panes: string[] = ["%250"]) {
  return fakeMux({
    currentWindow: () => location(pane),
    windowForPane: () => asWindowId("@1"),
    panesInWindow: () => panes.map(asPaneId),
  });
}

/** Every column of every agents row, straight from SQLite. Includes owner_pid. */
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

function attentionRows(): Record<string, unknown>[] {
  const database = new Database(dbPath(), { readonly: true });
  try {
    return database.prepare("SELECT * FROM attention ORDER BY pane, kind").all() as Record<
      string,
      unknown
    >[];
  } finally {
    database.close();
  }
}

/** Open a store, do one thing, close it: the commands open their own handles. */
function withStore<T>(work: (store: Store) => T): T {
  const store = openStore();
  try {
    return work(store);
  } finally {
    store.close();
  }
}

/**
 * `murmur notify`, over its own store handle.
 *
 * Deliberately NOT a handle shared with the assertions: the shipped verb opens
 * the database, writes, and closes, and a test that reused one open store would
 * miss anything that only shows up across handles.
 */
function notify(
  input: Parameters<typeof runNotify>[1],
  payload: Parameters<typeof runNotify>[2] = {},
  mux = inPane(),
): boolean {
  return withStore((store) => runNotify(store, input, payload, mux));
}

/** A claimed, RUNNING agent owned by this live process -- the case that was destroyed. */
function liveRunningAgent(pane = "%250"): string {
  return withStore((store) => {
    const claim = store.claimAgent({
      location: location(pane),
      owner_pid: process.pid,
      meta: META,
      now: 1000,
    });
    const agentId = "agent_id" in claim ? claim.agent_id : "";
    store.setActivity({
      agent_id: agentId,
      owner_pid: process.pid,
      activity: "running",
      location: location(pane),
      now: 2000,
    });
    return agentId;
  });
}

test("notify then focus cannot alter one byte of a live agent's row", () => {
  // THE regression test for the measured incident, driven through the two real
  // commands. `process.pid` is the owner and it is alive for the whole test, so
  // nothing here is excused by liveness: this is the exact live-owner case where
  // three `blocked` rows replaced `running` and nulled the owner metadata.
  //
  // Asserted on raw columns, not on a view. owner_pid is absent from
  // `localPanes()` by design, so a view-level assertion could not see it change.
  liveRunningAgent();
  const before = agentRows();

  notify({ source: "codex", eventType: "notify", title: "Codex", message: "needs input" });
  clearPane("%250", inPane());

  expect(agentRows()).toEqual(before);
  // And the row is still the agent we claimed, in case `before` was itself junk.
  expect(before[0]).toMatchObject({
    activity: "running",
    owner_pid: process.pid,
    agent_name: "worker-1",
    pi_session: "01JQ",
    workstream: "murmur",
    role: "implementer",
    cli: "pi",
    driver: "orchestrated",
    claimed_at: 1000,
    updated_at: 2000,
  });
});

test("a payload naming agent fields lands nowhere in the agents table", () => {
  // The old exception was narrow by CARE: notify chose `pid: null` and
  // `state: "blocked"` correctly at one call site. This asserts the structural
  // version -- a payload that tries to name an activity, a pid, an owner, a
  // workstream and a driver reaches a request type with no field for any of
  // them, so the values cannot appear in the agents table at all.
  liveRunningAgent();
  const before = agentRows();

  notify(
    { source: "hostile" },
    {
      // Not one of these has a field on `AttentionRequest` to land in.
      state: "stopped",
      activity: "stopped",
      pid: 4242,
      owner_pid: 4242,
      agent_id: "hijacked",
      agent_name: "hijacked",
      workstream: "hijacked",
      role: "hijacked",
      driver: "human",
      cli: "hijacked",
    },
  );

  expect(agentRows()).toEqual(before);
  // Asserted as a closed KEY set plus leaf VALUES, not as a substring search.
  //
  // This read `not.toContain("4242")` over the serialised rows, which fails on
  // an UNCORRUPTED row whenever the test's own `process.pid` happens to contain
  // those digits -- `owner_pid` is a real column here, and 14242 or 42421 are
  // ordinary macOS pids. Reproduced by claiming with owner_pid 14242: the
  // assertion fires while behaviour is correct. Same class as the millisecond
  // clock that made notify.test.ts flake, and the same fix.
  //
  // It also says the stronger thing. The claim is that `AttentionRequest` has no
  // field for any of these, so what matters is that no agent COLUMN took a value
  // from the payload -- checked per column, rather than hoping a digit string is
  // absent from a blob.
  const hostile = ["stopped", 4242, "hijacked", "human"];
  for (const row of agentRows()) {
    for (const [column, value] of Object.entries(row)) {
      // `driver` is legitimately "orchestrated" and `activity` "running"; the
      // point is that neither took the payload's word for it.
      expect(hostile, `${column} took a payload value`).not.toContain(value);
    }
  }
  // It did get its attention row -- refusing the write entirely would be a
  // different bug, since the notification is a real fact about the pane.
  expect(attentionRows()).toMatchObject([{ pane: "%250", kind: "blocked", source: "hostile" }]);
});

test("a running agent with blocked attention is a valid state, not a contradiction", () => {
  // The two axes are independent, so this pane is BOTH at once: `activity` lives
  // on the agent row and `blocked` is its own attention row, and a notifier
  // writing one cannot disturb the other.
  liveRunningAgent();
  notify({ source: "codex", message: "needs input" });

  const pane = withStore((store) => store.localPanes()[0]);
  expect(pane?.agent).toMatchObject({ activity: "running", agent_name: "worker-1" });
  expect(pane?.attention.map((entry) => entry.kind)).toEqual(["blocked"]);
  // A surface that must pick one word picks the request over the description.
  expect(renderState({ activity: "running", attention: ["blocked"] })).toBe("blocked");
});

test("focus acknowledges attention without ending the run it interrupted", () => {
  // Focusing a pane means "I have seen the request", never "the agent stopped".
  // The old focus path wrote a state, so looking at a working agent reported it
  // idle -- 50 of 84 turns on one agent were erased that way.
  liveRunningAgent();
  notify({ source: "codex", message: "needs input" });

  clearPane("%250", inPane());

  expect(attentionRows()).toEqual([]);
  expect(withStore((store) => store.localPanes()[0]?.agent)).toMatchObject({
    activity: "running",
  });
});

test("focus on a pane murmur has no agent for creates no agent row", () => {
  // A focus hook fires for every pane in the session, most of which are shells.
  // It must be a pure delete: a clear path that could INSERT would populate the
  // table with a row per shell the user ever looked at, each one indistinguishable
  // from an agent that never reports.
  clearPane("%shell", inPane("%shell", ["%shell"]));

  expect(agentRows()).toEqual([]);
  expect(attentionRows()).toEqual([]);
});

test("acknowledging one pane leaves every other pane's attention and agents alone", () => {
  // `acknowledgePane` is addressed by pane, and focus is only true of the pane
  // the user focused. A hook that cleared its neighbours would silently discard
  // requests nobody has seen.
  liveRunningAgent("%250");
  liveRunningAgent("%251");
  notify({ source: "codex", message: "a" }, {}, inPane("%250", ["%250", "%251"]));
  notify({ source: "codex", message: "b" }, {}, inPane("%251", ["%250", "%251"]));
  const before = agentRows();

  clearPane("%250", inPane("%250", ["%250", "%251"]));

  expect(attentionRows()).toMatchObject([{ pane: "%251", kind: "blocked", message: "b" }]);
  expect(agentRows()).toEqual(before);
});

test("a repeated notification does not restart the age of the request", () => {
  // Through the command, not the store: `runNotify` passes no `now`, so this also
  // pins that it does not smuggle a fresh clock past the upsert's exclusion of
  // `requested_at`. Age means "how long this has gone unmet"; a harness that
  // re-notifies every few seconds -- which codex does -- would otherwise keep a
  // day-old request looking new forever.
  notify({ source: "codex", message: "first" });
  const first = attentionRows()[0]?.requested_at;

  notify({ source: "codex", message: "second" });

  expect(attentionRows()).toMatchObject([{ message: "second", requested_at: first }]);
});
