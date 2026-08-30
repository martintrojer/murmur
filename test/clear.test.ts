import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { clearPane } from "../src/cli/clear.js";
import { asPaneId, asSessionId, asWindowId, type WindowId } from "../src/ids.js";
import { openStore, type Store } from "../src/store.js";
import type { AgentMeta, AttentionKind, Location } from "../src/types.js";
import { fakeMux } from "./helpers/fake-mux.js";

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-clear-"));
});

function location(pane: string, window = "@1"): Location {
  return {
    session: asSessionId("$1"),
    window: asWindowId(window),
    pane: asPaneId(pane),
    session_name: null,
    window_name: null,
  };
}

const META: AgentMeta = {
  agent_name: "worker-1",
  pi_session: null,
  workstream: "murmur",
  role: null,
  cli: "pi",
  driver: "human",
};

/** Seed the store, then close it: `clearPane` opens its own handle. */
function seed(work: (store: Store) => void): void {
  const store = openStore();
  try {
    work(store);
  } finally {
    store.close();
  }
}

function read<T>(work: (store: Store) => T): T {
  const store = openStore();
  try {
    return work(store);
  } finally {
    store.close();
  }
}

/** Badge writes made by the clear hook. */
function badgeRecorder(): {
  writes: [WindowId, unknown][];
  set: (window: WindowId, state: unknown) => void;
} {
  const writes: [WindowId, unknown][] = [];
  return { writes, set: (window, state) => void writes.push([window, state]) };
}

test("focus acknowledges every kind of attention on the pane", () => {
  // The reason clear exists. blocked, done and crashed all mean "look at me";
  // focusing the pane IS looking, so the request is satisfied and must stop
  // being shown -- otherwise the badge outlives the thing it reported.
  //
  // All kinds at once, in one statement, because (pane, kind) is the key and a
  // crashed row must not survive a focus that acknowledged the done next to it.
  seed((store) => {
    for (const kind of ["blocked", "done", "crashed"] as AttentionKind[]) {
      store.requestAttention({ kind, location: location("%1"), message: kind, source: "pi" });
    }
  });
  const badges = badgeRecorder();

  clearPane(
    "%1",
    fakeMux({
      windowForPane: () => asWindowId("@1"),
      panesInWindow: () => [asPaneId("%1")],
      setWindowBadge: badges.set,
    }),
  );

  expect(read((store) => store.localPanes())).toEqual([]);
  expect(badges.writes).toEqual([["@1", null]]);
});

test("focus cannot touch the agent in the pane, whatever it is doing", () => {
  // Focus can only run `DELETE FROM attention WHERE pane = ?`. There is no state
  // it must refuse to clear, because there is nothing it can clear except
  // attention -- which is what keeps a focus hook from wiping the report of a
  // running agent, as it once did for 50 of 84 turns on one agent. Asserted for
  // a RUNNING agent with a live pid, which is the case that used to be destroyed.
  const before = read((store) => {
    const claim = store.claimAgent({
      location: location("%1"),
      owner_pid: process.pid,
      meta: META,
    });
    store.setActivity({
      agent_id: "agent_id" in claim ? claim.agent_id : "",
      owner_pid: process.pid,
      activity: "running",
      location: location("%1"),
    });
    return store.localPanes();
  });

  const badges = badgeRecorder();
  clearPane(
    "%1",
    fakeMux({
      windowForPane: () => asWindowId("@1"),
      panesInWindow: () => [asPaneId("%1")],
      setWindowBadge: badges.set,
    }),
  );

  expect(read((store) => store.localPanes())).toEqual(before);
  expect(before[0]?.agent).toMatchObject({ activity: "running", agent_name: "worker-1" });
  expect(badges.writes).toEqual([["@1", "running"]]);
});

test("a pane murmur has never seen still gets its badge cleared", () => {
  // The tms picker and the status bar read @agent_state from tmux, not from
  // murmur. A badge murmur never wrote -- an orphan from the agent-attention
  // era, or a window it never recorded -- used to be unclearable, so the glyph
  // sat in the picker forever because nothing else would ever clear it.
  const badges = badgeRecorder();

  clearPane(
    "%unknown",
    fakeMux({ windowForPane: () => asWindowId("@42"), setWindowBadge: badges.set }),
  );

  expect(badges.writes).toEqual([["@42", null]]);
});

test("a sibling pane that still wants attention keeps the badge lit", () => {
  // The badge is a WINDOW option while "the user looked" is only true of one
  // pane, so focusing a shell next to a finished agent must not wipe its badge.
  //
  // The question is asked of ATTENTION only: a busy agent next door is not a
  // reason to keep an attention badge lit.
  seed((store) => {
    store.requestAttention({
      kind: "done",
      location: location("%agent"),
      message: "",
      source: "pi",
    });
    const claim = store.claimAgent({
      location: location("%busy"),
      owner_pid: process.pid,
      meta: META,
    });
    store.setActivity({
      agent_id: "agent_id" in claim ? claim.agent_id : "",
      owner_pid: process.pid,
      activity: "running",
      location: location("%busy"),
    });
  });
  const badges = badgeRecorder();
  const mux = fakeMux({
    windowForPane: () => asWindowId("@1"),
    panesInWindow: () => [asPaneId("%agent"), asPaneId("%busy"), asPaneId("%shell")],
    setWindowBadge: badges.set,
  });

  // Focusing the shell: the agent next door still wants attention.
  clearPane("%shell", mux);
  expect(badges.writes).toEqual([["@1", "done"]]);

  // Focusing the finished agent leaves the busy sibling's activity projected
  // onto the window rather than making it look idle.
  clearPane("%agent", mux);
  expect(badges.writes).toEqual([
    ["@1", "done"],
    ["@1", "running"],
  ]);
});

test("clear is silent and total when nothing can answer", () => {
  // It runs inside the tmux server, from a focus hook, so it must never throw
  // and never print -- and it must still clear what it can.
  expect(() => clearPane("")).not.toThrow();
  expect(() =>
    clearPane(
      "%1",
      fakeMux({
        windowForPane: () => {
          throw new Error("no tmux");
        },
      }),
    ),
  ).not.toThrow();
});
