import { expect, test } from "vitest";
import {
  type AgentView,
  attentionSort,
  foldAgent,
  isStale,
  type LiveCheck,
  type ResolvedState,
  resolveState,
  viewState,
} from "../src/fold.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
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
    session: asSessionId("session"),
    window: asWindowId("window"),
    pane: asPaneId("pane"),
    session_name: null,
    window_name: null,
    agent_name: null,
    pi_session: null,
    fetched_at: null,
  };
}

/**
 * The fold's own contract, which the resolver is layered on: `cleared` and an
 * empty history come back as NULL here, and only the resolver turns that into
 * `idle`. Pinned separately because the two vocabularies must not merge -- a
 * stored row can say `cleared`, a resolved agent cannot, and AgentView.state
 * being nullable is what the picker's "no event" rendering depends on.
 */
test("the fold reports absence as null, and the resolver is what names it", () => {
  expect(foldAgent([ev("cleared")], alive).state).toBeNull();
  expect(foldAgent([], alive).state).toBeNull();
  expect(resolveState([ev("cleared")], alive)).toBe("idle");
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

test("attention order is blocked, done, crashed, working, idle", () => {
  const order = attentionSort([v("working"), v(null), v("done"), v("blocked"), v("crashed")]);
  expect(order.map((view) => view.state)).toEqual(["blocked", "done", "crashed", "working", null]);
});

test("freshness is not a state", () => {
  expect(isStale(Date.now() - 5_000, Date.now())).toBe(false);
  expect(isStale(Date.now() - 120_000, Date.now())).toBe(true);
  expect(isStale(null, Date.now())).toBe(false);
});

/**
 * THE CASE TABLE. One resolver, one place the matrix is asserted.
 *
 * Fourteen sites used to derive some part of this independently, and six shipped
 * bugs came from the seams. The point of the table being here is that callers no
 * longer need to re-test it: clear, status, pick and export each prove only that
 * they CONSULT the resolver, not what it decides.
 */
test("the resolver answers every case one table, exhaustively", () => {
  const cases: [string, Event[], LiveCheck, ResolvedState][] = [
    // A working row is working only while its pid answers.
    ["working + live pid", [ev("working", { pid: 1 })], alive, "working"],
    ["working + dead pid", [ev("working", { pid: 4242 })], dead, "crashed"],
    // No pid at all cannot be evidence of life. This is the case the extension
    // never writes but a foreign or older node might.
    ["working + no pid", [ev("working", { pid: null })], alive, "crashed"],
    ["working + pid 0", [ev("working", { pid: 0 })], alive, "crashed"],
    // Attention states are terminal and carry no pid, so liveness cannot touch
    // them. Asserted under BOTH probes, because a resolver that consulted the
    // probe here would silently turn a finished agent into a crashed one.
    ["blocked", [ev("blocked")], alive, "blocked"],
    ["blocked, dead probe", [ev("blocked")], dead, "blocked"],
    ["done", [ev("done")], alive, "done"],
    ["done, dead probe", [ev("done")], dead, "done"],
    ["crashed", [ev("crashed")], alive, "crashed"],
    // A clear means "nothing to see", which is idle -- never the string
    // "cleared", which is why ResolvedState does not contain it.
    ["cleared", [ev("cleared")], alive, "idle"],
    ["no events at all", [], alive, "idle"],
    // A state only a NEWER node knows about must not wedge the scan, and must
    // not be reported as itself: this version cannot say what it means.
    ["unknown state from a newer node", [ev("wat" as AgentState)], alive, "idle"],
    [
      "unknown state above a working row",
      [ev("working", { pid: 1 }), ev("wat" as AgentState)],
      alive,
      "working",
    ],
    // A remote row, folded with no local pid knowledge. status.ts trusts these
    // because the authoring node checked its own process table before exporting.
    ["remote working, pid unknowable", [ev("working", { pid: 999_999 })], alive, "working"],
    // Ordering: the newest row that says something wins, over any older one.
    ["newest wins over older", [ev("working", { pid: 1 }), ev("blocked")], alive, "blocked"],
    [
      "crashed is sticky over a live working row",
      [ev("working", { pid: 1 }), ev("crashed")],
      alive,
      "crashed",
    ],
    ["a clear supersedes an attention state", [ev("blocked"), ev("cleared")], alive, "idle"],
    // The real production sequence from the agent_settled work.
    [
      "working, done, blocked",
      [ev("working", { pid: 1 }), ev("done"), ev("blocked")],
      alive,
      "blocked",
    ],
  ];

  for (const [label, events, probe, expected] of cases) {
    expect(resolveState(events, probe), label).toBe(expected);
  }
});

test("the resolver fails CLOSED, so an unanswerable pid is never clearable", () => {
  // cbcd9c4 wiped 50 of 84 turns on one agent by letting a clear path overwrite
  // `working`. The direction of this failure is the whole safety property:
  // pidAlive reports death only on ESRCH, so a probe that cannot answer (EPERM,
  // or anything else) says alive -> `working` -> not in CLEARABLE.
  //
  // A resolver that failed OPEN would resolve the same row to `crashed`, which
  // IS clearable, and focus would silently overwrite a running agent.
  const unanswerable: LiveCheck = () => true;
  expect(resolveState([ev("working", { pid: 4242 })], unanswerable)).toBe("working");
});

test("viewState translates an already-folded agent without re-probing", () => {
  // The picker and the status bar hold AgentViews, not events: status() folds
  // once. They have no pid to probe and must not pretend otherwise, so the
  // last step of the resolver is available on its own.
  expect(viewState({ state: null })).toBe("idle");
  expect(viewState({ state: "working" })).toBe("working");
  expect(viewState({ state: "blocked" })).toBe("blocked");
  // Unreachable from a fold, and handled anyway: `cleared` is in AgentState, so
  // the signature does not rule it out, and degrading to `idle` is correct
  // rather than a cast that would hide a future fold path returning it.
  expect(viewState({ state: "cleared" })).toBe("idle");
});
