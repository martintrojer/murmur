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
    liveness: "unknown",
  };
}

test("blocked is terminal and wins over a later-scanned working", () => {
  expect(foldAgent([ev("working", { pid: 1 }), ev("blocked")], alive).state).toBe("blocked");
});

test("cleared resets to null", () => {
  expect(foldAgent([ev("blocked"), ev("cleared")], alive).state).toBeNull();
});

// --- liveness of an idle row ------------------------------------------------
//
// Observed on a real machine: two panes reported `cleared` with their pi
// processes very much alive, and read as plain `idle` in the picker for hours.
// `cleared` is emitted at the end of every TURN when the pane is focused, not
// at the end of the session, so a pi you are actively using sits there between
// turns. Idle is the right STATE -- it wants nothing -- but it collapsed "still
// running" and "exited long ago" into one indistinguishable row.

test("an idle agent whose process is alive is reported alive", () => {
  const folded = foldAgent([ev("working", { pid: 4242 }), ev("cleared")], alive);

  // Still idle: liveness is a separate axis, not a state. Making it a state
  // would force every consumer to order it against blocked/done/crashed.
  expect(folded.state).toBeNull();
  expect(folded.liveness).toBe("alive");
});

test("an idle agent whose process is gone is reported exited", () => {
  const folded = foldAgent([ev("working", { pid: 4242 }), ev("cleared")], dead);

  expect(folded.state).toBeNull();
  expect(folded.liveness).toBe("exited");
});

test("the pid is recovered from an earlier event, since cleared carries none", () => {
  // The reason this needed a helper rather than reading `event.pid`. Both
  // `cleared` and `done` are emitted with `pid: null` -- the process is not
  // their subject -- so the last event with a pid is the only source. Same
  // agent_id means the same pane, hence the same process.
  const checked: number[] = [];
  const spy: LiveCheck = (pid) => {
    checked.push(pid);
    return true;
  };

  const folded = foldAgent([ev("working", { pid: 4242 }), ev("done"), ev("cleared")], spy);

  expect(checked).toEqual([4242]);
  expect(folded.liveness).toBe("alive");
});

test("a nonsense pid is not treated as a process to check", () => {
  // pid 0 is not a process a node can own -- it means "this process group" to
  // kill(2), so passing it to a liveness check asks a different question than
  // intended and answers true. A zero or negative pid on an event is corrupt
  // data or an old schema, and the honest answer is that we do not know.
  const checked: number[] = [];
  const spy: LiveCheck = (pid) => {
    checked.push(pid);
    return true;
  };

  expect(foldAgent([ev("working", { pid: 0 }), ev("cleared")], spy).liveness).toBe("unknown");
  expect(foldAgent([ev("working", { pid: -1 }), ev("cleared")], spy).liveness).toBe("unknown");
  expect(checked).toEqual([]);
});

test("a pid too old to mean anything is not trusted", () => {
  // Pids are recycled, and measurably fast: pids advanced ~9/sec on an idle
  // machine, so darwin's 99999-pid space wraps in about three hours. An old pid
  // can name an unrelated process, and pidAlive cannot tell -- it only asks
  // whether SOMETHING holds that number.
  //
  // Reachable rather than theoretical. Retention keeps the newest event per
  // agent forever so idle rows never age out, and the author's machine held
  // 24-hour-old idle rows carrying pids. `alive` on those is a coin flip, and
  // `unknown` is what is actually known.
  const ancient = foldAgent(
    [ev("working", { pid: 4242, ts: NOW - 48 * 3_600_000 }), ev("cleared", { ts: NOW })],
    alive,
  );
  expect(ancient.liveness).toBe("unknown");

  // Age is taken from the event that CARRIED the pid, not from the fold: a
  // fresh `cleared` does not make an old pid trustworthy again.
  const recent = foldAgent(
    [ev("working", { pid: 4242, ts: NOW - 60_000 }), ev("cleared", { ts: NOW })],
    alive,
  );
  expect(recent.liveness).toBe("alive");

  // Just past the horizon, to pin the boundary rather than only the extremes:
  // a 2-hour-old pid is inside the pid-space wrap and must not be trusted.
  const borderline = foldAgent(
    [ev("working", { pid: 4242, ts: NOW - 2 * 3_600_000 }), ev("cleared", { ts: NOW })],
    alive,
  );
  expect(borderline.liveness).toBe("unknown");
});

test("an idle agent that never reported a pid is unknown, not exited", () => {
  // "exited" is a claim about a process. With no pid there is nothing to check,
  // and answering `exited` would invent a fact -- the row would suggest closing
  // a pane that may be perfectly alive. Pre-pid events and non-pi harnesses
  // both land here.
  const folded = foldAgent([ev("cleared")], dead);

  expect(folded.liveness).toBe("unknown");
});

test("a remote idle agent's pid is never checked against this machine", () => {
  // A pid only means something in its own machine's process table. Checking a
  // remote one locally answers about an unrelated process, so a remote idle row
  // must stay `unknown` however tempting the pid looks.
  const checked: number[] = [];
  const spy: LiveCheck = (pid) => {
    checked.push(pid);
    return true;
  };

  const folded = foldAgent([ev("working", { pid: 4242 }), ev("cleared")], spy, false);

  expect(checked).toEqual([]);
  expect(folded.liveness).toBe("unknown");
});

test("liveness is only claimed for idle rows", () => {
  // The states that mean something on their own must not also carry a liveness
  // hint, or two fields would answer the same question and could disagree.
  // `working` already folds a dead pid to `crashed`, which is the right place
  // for that logic.
  expect(foldAgent([ev("blocked", { pid: 1 })], alive).liveness).toBe("unknown");
  expect(foldAgent([ev("done", { pid: 1 })], alive).liveness).toBe("unknown");
  expect(foldAgent([ev("working", { pid: 1 })], alive).liveness).toBe("unknown");
  expect(foldAgent([ev("crashed", { pid: 1 })], alive).liveness).toBe("unknown");
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
  expect(folded.liveness).toBe("alive");
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
