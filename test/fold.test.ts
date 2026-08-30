import { expect, test } from "vitest";
import { type AgentView, attentionSort, foldAgent, isStale, type LiveCheck } from "../src/fold.js";
import type { AgentState, Event } from "../src/types.js";

const alive: LiveCheck = () => true;
const dead: LiveCheck = () => false;

// A recent default ts: liveness only trusts a pid for a bounded window, so a
// fixture stuck at the epoch would make every pid look ancient and every
// liveness assertion pass for the wrong reason.
const NOW = Date.now();

function ev(state: AgentState, partial: Partial<Event> = {}): Event {
  return {
    host_id: "host",
    seq: 1,
    ts: NOW,
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
    state,
    message: "",
    pid: null,
    synthetic: false,
    reason: "",
    extra: {},
    ...partial,
  };
}

function v(state: AgentState | null): AgentView {
  const event = state === null ? null : ev(state);
  return {
    agent_id: "agent",
    host_id: "host",
    state,
    event,
    workstream: null,
    role: null,
    cli: null,
    driver: "human",
    session: "session",
    window: "window",
    pane: "pane",
    session_name: null,
    window_name: null,
    agent_name: null,
    pi_session: null,
    fetched_at: null,
  };
}

test("blocked is terminal and wins over a later-scanned working", () => {
  expect(foldAgent([ev("working", { pid: 1 }), ev("blocked")], alive).state).toBe("blocked");
});

test("cleared resets to null", () => {
  expect(foldAgent([ev("blocked"), ev("cleared")], alive).state).toBeNull();
});

test("a cleared event's timestamp does not become the row's age", () => {
  // The event is still dropped on purpose. It is a *clear*, so letting it
  // survive would make "last said something" mean "last stopped saying
  // something", and every idle row would look freshly active.
  // Relative to NOW, so the pid stays inside the trust window: this test is
  // about the event being dropped, not about pid age.
  const folded = foldAgent(
    [ev("working", { pid: 1, ts: NOW - 2000 }), ev("cleared", { ts: NOW - 1000 })],
    alive,
  );

  expect(folded.event).toBeNull();
});

test("working with a dead pid synthesizes crashed", () => {
  expect(foldAgent([ev("working", { pid: 4242 })], dead).state).toBe("crashed");
});

test("working with a live pid stays working", () => {
  expect(foldAgent([ev("working", { pid: 1 })], alive).state).toBe("working");
});

test("crashed is sticky", () => {
  expect(foldAgent([ev("working", { pid: 1 }), ev("crashed")], alive).state).toBe("crashed");
});

test("unrecognised states do not wedge the scan", () => {
  expect(foldAgent([ev("blocked"), ev("wat" as AgentState)], alive).state).toBe("blocked");
});

test("attention order is blocked, done, crashed, working, idle", () => {
  const order = attentionSort([v("working"), v(null), v("done"), v("blocked"), v("crashed")]);
  expect(order.map((view) => view.state)).toEqual(["blocked", "done", "crashed", "working", null]);
});

test("freshness is not a state", () => {
  expect(isStale(Date.now() - 5_000, Date.now())).toBe(false);
  expect(isStale(Date.now() - 120_000, Date.now())).toBe(true);
  expect(isStale(null, Date.now())).toBe(false);
});
