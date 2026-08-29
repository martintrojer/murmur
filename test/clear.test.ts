import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { clearPane } from "../src/cli/clear.js";
import { ensureIdentity } from "../src/identity.js";
import type { Mux } from "../src/mux.js";
import { openStore } from "../src/store.js";

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-clear-"));
});

test("clearing a sibling pane does not clear the agent in the same window", () => {
  const identity = ensureIdentity();
  const store = openStore();
  store.append({
    agent_id: `${identity.host_id}:%1`,
    session: "$1",
    window: "@1",
    pane: "%1",
    workstream: "murmur",
    role: null,
    cli: "pi",
    driver: "human",
    kind: "state",
    state: "done",
    message: "",
    pid: null,
    synthetic: false,
    reason: "",
    extra: {},
  });
  store.close();

  const clearedWindows: string[] = [];
  const mux: Mux = {
    currentWindow: () => null,
    setState: (window) => clearedWindows.push(window),
    attach: () => {},
    capture: () => null,
    windowNames: () => new Map(),
    windowForPane: () => null,
    panesInWindow: () => [],
    windowNamed: () => null,
    selectWindow: () => {},
    liveWindows: () => new Set<string>(),
  };

  clearPane("%2", mux);

  const afterWrongPane = openStore();
  expect(afterWrongPane.allEvents().filter((event) => event.state === "cleared")).toHaveLength(0);
  afterWrongPane.close();
  expect(clearedWindows).toEqual([]);

  clearPane("%1", mux);

  const afterAgentPane = openStore();
  expect(afterAgentPane.allEvents().at(-1)).toMatchObject({
    agent_id: `${identity.host_id}:%1`,
    pane: "%1",
    window: "@1",
    state: "cleared",
  });
  afterAgentPane.close();
  expect(clearedWindows).toEqual(["@1"]);
});

test("a pane murmur does not own still gets its badge cleared", () => {
  // The tms picker and the status bar read @agent_state from tmux, not from
  // murmur. A badge murmur never wrote — an orphan from the agent-attention
  // era, or a window it never recorded — used to be unclearable: clear() bailed
  // when it found no event, so the glyph sat in the picker forever because
  // nothing else would ever come along to clear it. The badge is tmux's.
  const cleared: (string | null)[] = [];
  const mux: Mux = {
    currentWindow: () => null,
    liveWindows: () => new Set<string>(),
    setState: (window, state) => {
      cleared.push(state === null ? window : null);
    },
    attach: () => {},
    capture: () => null,
    windowNames: () => new Map(),
    windowForPane: () => "@42",
    panesInWindow: () => [],
    windowNamed: () => null,
    selectWindow: () => {},
  };
  clearPane("%unknown", mux);
  expect(cleared).toEqual(["@42"]);
});

const NEW_EVENT = {
  session: "$1",
  window: "@1",
  pane: "%1",
  session_name: null,
  window_name: null,
  agent_name: null,
  pi_session: null,
  workstream: "murmur",
  role: null,
  cli: "pi",
  driver: "human" as const,
  kind: "state",
  state: "done",
  message: "",
  pid: null,
  synthetic: false,
  reason: "",
  extra: {},
};

const NOOP_MUX: Mux = {
  currentWindow: () => null,
  liveWindows: () => new Set<string>(),
  setState: () => {},
  attach: () => {},
  capture: () => null,
  windowNames: () => new Map(),
  windowForPane: () => null,
  panesInWindow: () => [],
  windowNamed: () => null,
  selectWindow: () => {},
};

test("a sibling shell pane does not clear the agent's badge", () => {
  // The badge is a window option, but "the user looked" is only true of one
  // pane. Clearing on any pane in the window let a shell pane next to an agent
  // wipe its badge on focus -- the exact case --pane exists to distinguish. The
  // existing sibling test above never caught this: its fake mux returns no
  // panes, so the branch was unreachable.
  const identity = ensureIdentity();
  const store = openStore();
  store.append({ ...NEW_EVENT, agent_id: `${identity.host_id}:%agent`, pane: "%agent" });
  store.close();

  const cleared: string[] = [];
  const mux: Mux = {
    ...NOOP_MUX,
    windowForPane: () => "@1",
    panesInWindow: () => ["%agent", "%shell"],
    setState: (window, state) => {
      if (state === null) cleared.push(window);
    },
  };
  // Focusing the shell, which murmur has no row for.
  clearPane("%shell", mux);
  expect(cleared).toEqual([]);
});

test("an already-cleared row still clears a stale badge", () => {
  // The row and the badge can disagree: a `cleared` event written by a path
  // that did not touch tmux leaves the option set, and returning early on
  // state === "cleared" meant nothing ever reconciled them. A done badge then
  // sat in the status bar and the tms picker permanently.
  const identity = ensureIdentity();
  const store = openStore();
  store.append({
    ...NEW_EVENT,
    agent_id: `${identity.host_id}:%p`,
    pane: "%p",
    window: "@5",
    state: "cleared",
  });
  store.close();

  const cleared: string[] = [];
  const mux: Mux = {
    ...NOOP_MUX,
    windowForPane: () => "@5",
    panesInWindow: () => ["%p"],
    setState: (window, state) => {
      if (state === null) cleared.push(window);
    },
  };
  clearPane("%p", mux);
  expect(cleared).toEqual(["@5"]);
});
