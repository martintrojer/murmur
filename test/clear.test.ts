import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { clearPane } from "../src/cli/clear.js";
import { ensureIdentity } from "../src/identity.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import type { Mux } from "../src/mux.js";
import { openStore } from "../src/store.js";
import { fakeMux } from "./helpers/fake-mux.js";

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-clear-"));
});

test("clearing a sibling pane does not clear the agent in the same window", () => {
  const identity = ensureIdentity();
  const store = openStore();
  store.append({
    agent_id: `${identity.host_id}:%1`,
    session: asSessionId("$1"),
    window: asWindowId("@1"),
    pane: asPaneId("%1"),
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
  const mux = fakeMux({ setState: (window) => void clearedWindows.push(window) });

  clearPane("%2", mux);

  const afterWrongPane = openStore();
  expect(afterWrongPane.allEvents().filter((event) => event.state === "cleared")).toHaveLength(0);
  afterWrongPane.close();
  expect(clearedWindows).toEqual([]);

  clearPane("%1", mux);

  const afterAgentPane = openStore();
  expect(afterAgentPane.allEvents().at(-1)).toMatchObject({
    agent_id: `${identity.host_id}:%1`,
    pane: asPaneId("%1"),
    window: asWindowId("@1"),
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
  const mux = fakeMux({
    setState: (window, state) => {
      cleared.push(state === null ? window : null);
    },
    windowForPane: () => asWindowId("@42"),
  });
  clearPane("%unknown", mux);
  expect(cleared).toEqual(["@42"]);
});

const NEW_EVENT = {
  session: asSessionId("$1"),
  window: asWindowId("@1"),
  pane: asPaneId("%1"),
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

const NOOP_MUX: Mux = fakeMux();

test("a sibling shell pane does not clear the agent's badge", () => {
  // The badge is a window option, but "the user looked" is only true of one
  // pane. Clearing on any pane in the window let a shell pane next to an agent
  // wipe its badge on focus -- the exact case --pane exists to distinguish. The
  // existing sibling test above never caught this: its fake mux returns no
  // panes, so the branch was unreachable.
  const identity = ensureIdentity();
  const store = openStore();
  store.append({ ...NEW_EVENT, agent_id: `${identity.host_id}:%agent`, pane: asPaneId("%agent") });
  store.close();

  const cleared: string[] = [];
  const mux: Mux = {
    ...NOOP_MUX,
    windowForPane: () => asWindowId("@1"),
    panesInWindow: () => [asPaneId("%agent"), asPaneId("%shell")],
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
    pane: asPaneId("%p"),
    window: asWindowId("@5"),
    state: "cleared",
  });
  store.close();

  const cleared: string[] = [];
  const mux: Mux = {
    ...NOOP_MUX,
    windowForPane: () => asWindowId("@5"),
    panesInWindow: () => [asPaneId("%p")],
    setState: (window, state) => {
      if (state === null) cleared.push(window);
    },
  };
  clearPane("%p", mux);
  expect(cleared).toEqual(["@5"]);
});

test("focusing a working agent does not clear it", () => {
  // The bug, found by watching a real session: 50 of 84 turns on the author's
  // own agent were cleared within a minute of starting, several within seconds.
  // Switching back to an agent's pane while it was thinking wiped its state.
  //
  // `clear` runs from tmux focus hooks, so the only fact it knows is "the user
  // looked at this pane". That cancels an attention REQUEST -- blocked, done,
  // crashed -- but `working` is not a request: it is the agent reporting what it
  // is doing, and looking at it does not make it stop. Overwriting it also
  // breaks murmur's own rule that facts only the author can know are authored
  // by the author, since only the agent knows whether it is still working.
  //
  // The consequence was severe because `working` is only re-asserted at the
  // start of a turn: once cleared mid-turn, the agent read idle until its NEXT
  // turn began, which for a long turn is many minutes.
  const identity = ensureIdentity();
  const store = openStore();
  store.append({ ...NEW_EVENT, agent_id: `${identity.host_id}:%1`, state: "working", pid: 4242 });
  store.close();

  const badges: (string | null)[] = [];
  clearPane("%1", fakeMux({ setState: (_window, state) => void badges.push(state) }));

  const after = openStore();
  const events = after.allEvents();
  // No `cleared` appended: the agent is still working, and only it may say
  // otherwise.
  expect(events.at(-1)?.state).toBe("working");
  after.close();

  // And the badge is left alone. A `working` badge is not an attention request
  // either, so there is nothing for focus to acknowledge.
  expect(badges).toEqual([]);
});

test("focusing an agent that wants attention still clears it", () => {
  // The other side, and the reason clear exists at all. blocked, done and
  // crashed are all "look at me"; focusing the pane IS looking, so the request
  // is satisfied and must stop being shown -- otherwise the badge outlives the
  // thing it was reporting and sits in the status bar forever.
  for (const state of ["blocked", "done", "crashed"] as const) {
    process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), `murmur-clear-${state}-`));
    const identity = ensureIdentity();
    const store = openStore();
    store.append({ ...NEW_EVENT, agent_id: `${identity.host_id}:%1`, state });
    store.close();

    const badges: (string | null)[] = [];
    clearPane("%1", fakeMux({ setState: (_window, badge) => void badges.push(badge) }));

    const after = openStore();
    expect(after.allEvents().at(-1)?.state).toBe("cleared");
    after.close();
    expect(badges).toEqual([null]);
  }
});
