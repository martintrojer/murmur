import { expect, test } from "vitest";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import type { AttentionKind } from "../src/types.js";
import {
  age,
  freshness,
  type PaneView,
  RENDER_PRIORITY,
  renderState,
  STALENESS_MS,
  viewSort,
} from "../src/view.js";

/**
 * The view: the typed, direct read over the three independent facts.
 *
 * `status.test.ts` owns what the surfaces print and `peer-cache.test.ts` owns
 * what a peer contributes. This file owns the pure functions themselves --
 * ordering, one-word rendering, freshness and age -- because those are where the
 * old fold's compensations lived, and each claim here is a claim about what the
 * view CANNOT do: infer liveness, reorder equal rows differently on two runs, or
 * let a duration be turned into a verdict anywhere else.
 */

function view(over: Partial<PaneView> = {}): PaneView {
  return {
    host_id: "H",
    host: "here",
    local: true,
    pane: asPaneId("%1"),
    session: asSessionId("$0"),
    window: asWindowId("@0"),
    session_name: "work",
    window_name: "w",
    activity: "stopped",
    attention: [],
    freshness: "fresh",
    agent_id: "a-1",
    agent_name: null,
    pi_session: null,
    workstream: null,
    role: null,
    cli: "pi",
    driver: "human",
    updated_at: 1_000,
    snapshot_at: null,
    fetched_at: null,
    ...over,
  };
}

test("renderState picks one word by priority, and attention beats activity", () => {
  // Presentation only: the facts underneath are untouched, which is why a
  // running agent that is also blocked reads as `blocked` here and still
  // reports `activity: "running"` to any surface with room for both.
  expect(renderState(view({ activity: "running", attention: [] }))).toBe("running");
  expect(renderState(view({ activity: "stopped", attention: [] }))).toBe("idle");
  expect(renderState(view({ activity: null, attention: [] }))).toBe("idle");
  expect(renderState(view({ activity: "running", attention: ["done"] }))).toBe("done");
  expect(renderState(view({ activity: "running", attention: ["blocked"] }))).toBe("blocked");
  expect(renderState(view({ activity: "running", attention: ["crashed", "blocked"] }))).toBe(
    "crashed",
  );
  // Order in the array does not decide; the priority table does. A pane that
  // arrived with its kinds in any order renders the same.
  expect(renderState(view({ activity: "running", attention: ["done", "crashed"] }))).toBe(
    "crashed",
  );
});

test("RENDER_PRIORITY is the one ordering table and every render state is in it", () => {
  // The three near-identical copies that used to exist disagreed about whether
  // `crashed` or `blocked` led, so two surfaces sorted one list two ways. A
  // state missing from the table would sort by a fallback and reappear as the
  // same class of bug.
  expect([...RENDER_PRIORITY]).toEqual(["crashed", "blocked", "done", "running", "idle"]);
  const states = new Set(RENDER_PRIORITY);
  for (const attention of [["crashed"], ["blocked"], ["done"], []] as AttentionKind[][]) {
    for (const activity of ["running", "stopped", null] as PaneView["activity"][]) {
      expect(states.has(renderState(view({ activity, attention })))).toBe(true);
    }
  }
});

test("viewSort orders by render priority, then by the newest news", () => {
  const rows = [
    view({ pane: asPaneId("%idle"), activity: "stopped" }),
    view({ pane: asPaneId("%old-blocked"), attention: ["blocked"], updated_at: 1 }),
    view({ pane: asPaneId("%run"), activity: "running" }),
    view({ pane: asPaneId("%new-blocked"), attention: ["blocked"], updated_at: 9 }),
    view({ pane: asPaneId("%crash"), attention: ["crashed"] }),
  ];

  expect(viewSort(rows).map((row) => row.pane)).toEqual([
    "%crash",
    "%new-blocked",
    "%old-blocked",
    "%run",
    "%idle",
  ]);
});

test("viewSort leaves its input alone, so a caller may sort a shared list twice", () => {
  const rows = [
    view({ pane: asPaneId("%a") }),
    view({ pane: asPaneId("%b"), attention: ["done"] }),
  ];
  const before = rows.map((row) => row.pane);

  viewSort(rows);

  expect(rows.map((row) => row.pane)).toEqual(before);
});

test("a null updated_at sorts last within its state rather than ahead of a known age", () => {
  // An attention-only pane whose only trace has no timestamp must not outrank a
  // pane that reported a second ago: unknown is not new.
  const rows = [
    view({ pane: asPaneId("%unknown"), attention: ["done"], updated_at: null }),
    view({ pane: asPaneId("%known"), attention: ["done"], updated_at: 5 }),
  ];

  expect(viewSort(rows).map((row) => row.pane)).toEqual(["%known", "%unknown"]);
});

test("ordering is TOTAL: equal state and equal age break on host and pane, both directions", () => {
  // Two panes that tie on state and on `updated_at` are common -- a crashed pair
  // reconciled in one transaction shares a `requested_at` exactly -- and
  // Array.prototype.sort is only stable with respect to the INPUT order, so a
  // tie left unbroken makes the list depend on the order the store happened to
  // return. A status bar that reshuffles between two identical ticks is the
  // visible symptom; a picker whose rows move under a keypress is the harmful
  // one.
  const left = view({ host: "alpha", pane: asPaneId("%1"), attention: ["crashed"], updated_at: 7 });
  const right = view({ host: "beta", pane: asPaneId("%2"), attention: ["crashed"], updated_at: 7 });

  expect(viewSort([left, right]).map((row) => row.pane)).toEqual(["%1", "%2"]);
  expect(viewSort([right, left]).map((row) => row.pane)).toEqual(["%1", "%2"]);

  // Same host, so the pane id is what decides.
  const twin = view({ host: "alpha", pane: asPaneId("%9"), attention: ["crashed"], updated_at: 7 });
  expect(viewSort([twin, left]).map((row) => row.pane)).toEqual(["%1", "%9"]);
  expect(viewSort([left, twin]).map((row) => row.pane)).toEqual(["%1", "%9"]);
});

test("freshness is a verdict about a NODE, and a node never reached is stale", () => {
  // Null is the first-collect-has-not-succeeded case. Rendering an unreachable
  // host you just added as up to date is the one answer that misleads.
  expect(freshness(null, 1_000)).toBe("stale");
  expect(freshness(1_000, 1_000)).toBe("fresh");
  expect(freshness(1_000, 1_000 + STALENESS_MS)).toBe("fresh");
  expect(freshness(1_000, 1_000 + STALENESS_MS + 1)).toBe("stale");
  // A clock that went backwards reads as fresh rather than stale: we DID reach
  // the node, and a skewed clock is not evidence of silence.
  expect(freshness(2_000, 1_000)).toBe("fresh");
  // The threshold is a parameter so a caller can ask a different question
  // without a second definition of the verdict.
  expect(freshness(1_000, 6_000, 1_000)).toBe("stale");
  expect(freshness(1_000, 6_000, 10_000)).toBe("fresh");
});

test("age is the shortest thing worth reading, and sub-minute is silence", () => {
  expect(age(null)).toBe("");
  expect(age(0)).toBe("");
  expect(age(59_999)).toBe("");
  expect(age(60_000)).toBe("1m");
  expect(age(3_599_999)).toBe("59m");
  expect(age(3_600_000)).toBe("1h");
  expect(age(86_399_999)).toBe("23h");
  expect(age(86_400_000)).toBe("1d");
  expect(age(10 * 86_400_000)).toBe("10d");
  // A negative duration is a clock disagreement, not an age, and it must not
  // print "-1m" into a status bar.
  expect(age(-1_000)).toBe("");
});
