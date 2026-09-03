import { expect, test } from "vitest";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import type { AttentionKind } from "../src/types.js";
import {
  age,
  freshness,
  NEEDS_HUMAN,
  type PaneAttention,
  type PaneView,
  RENDER_PRIORITY,
  renderState,
  STALENESS_MS,
  viewSort,
  wants,
} from "../src/view.js";

/**
 * Attention kinds as the view now carries them: each with its own clock.
 *
 * Defaults to the pane's `updated_at` so every pre-existing case in this file
 * keeps the age it was written with, and the tests that care about a per-kind
 * age say so explicitly.
 */
function at(kinds: AttentionKind[], requested_at = 1_000): PaneAttention[] {
  return kinds.map((kind) => ({ kind, requested_at }));
}

/**
 * The view: the typed, direct read over the three independent facts.
 *
 * `status.test.ts` owns what the surfaces print and `peer-cache.test.ts` owns
 * what a peer contributes. This file owns the pure functions themselves --
 * ordering, one-word rendering, freshness and age. Each claim here is a claim
 * about what the view CANNOT do: infer liveness, reorder equal rows differently
 * on two runs, or let a duration be turned into a verdict anywhere else.
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
  expect(renderState(view({ activity: "running", attention: at(["done"]) }))).toBe("done");
  expect(renderState(view({ activity: "running", attention: at(["blocked"]) }))).toBe("blocked");
  expect(renderState(view({ activity: "running", attention: at(["crashed", "blocked"]) }))).toBe(
    "crashed",
  );
  // Order in the array does not decide; the priority table does. A pane that
  // arrived with its kinds in any order renders the same.
  expect(renderState(view({ activity: "running", attention: at(["done", "crashed"]) }))).toBe(
    "crashed",
  );
});

test("wants asks about a kind without caring which one the pane renders as", () => {
  // The read side of the widened `attention`. A pane renders ONE word, and every
  // surface that has to ask "is this also blocked" -- the picker's visibility
  // rule, the status bar's crew counts -- must ask the array rather than the
  // rendered word, or a crashed-and-blocked pane answers no to `blocked`.
  const both = view({ attention: at(["crashed", "blocked"]) });
  expect(renderState(both)).toBe("crashed");
  expect(wants(both, "crashed")).toBe(true);
  expect(wants(both, "blocked")).toBe(true);
  expect(wants(both, "done")).toBe(false);
  expect(wants(view({ attention: [] }), "blocked")).toBe(false);
});

test("RENDER_PRIORITY is the one ordering table and every render state is in it", () => {
  // One table, so no two surfaces can disagree about whether `crashed` or
  // `blocked` leads. A state missing from it would sort by a fallback, which is
  // how a row moves under the keypress aimed at it.
  expect([...RENDER_PRIORITY]).toEqual(["crashed", "blocked", "done", "running", "idle"]);
  const states = new Set(RENDER_PRIORITY);
  for (const attention of [["crashed"], ["blocked"], ["done"], []] as AttentionKind[][]) {
    for (const activity of ["running", "stopped", null] as PaneView["activity"][]) {
      expect(states.has(renderState(view({ activity, attention: at(attention) })))).toBe(true);
    }
  }
});

test("NEEDS_HUMAN is the one table deciding which crew states reach a human", () => {
  // The second shared table, and the one whose duplication was load-bearing: the
  // picker's default visibility and the status bar's crew counts must answer
  // "which orchestrated states does a human have to see" identically, or a
  // blocked crew agent is counted in the status bar and hidden from the list you
  // open to act on it.
  expect([...NEEDS_HUMAN]).toEqual(["blocked", "crashed"]);

  // Every entry names an attention kind, not a render state. A `running` or
  // `idle` here would ask a human to answer a description rather than a request.
  const kinds = new Set<AttentionKind>(["done", "blocked", "crashed"]);
  for (const kind of NEEDS_HUMAN) expect(kinds.has(kind)).toBe(true);

  // `done` is deliberately absent: a supervisor consumes a finished worker's
  // result, so nobody has to acknowledge it.
  expect(NEEDS_HUMAN).not.toContain("done");
});

/** A row wanting one kind of attention, asked for at a known time. */
function asked(pane: string, kind: AttentionKind, requested_at: number): PaneView {
  return view({
    pane: asPaneId(pane),
    attention: at([kind], requested_at),
    updated_at: requested_at,
  });
}

const NOW = 10_000_000;

test("viewSort orders by render priority first, and nothing below may cross a band", () => {
  // The band is the one thing a reader is entitled to read off a position, so
  // every signal added below decides only who leads WITHIN a band. An `idle`
  // row local, in your stream, sitting in your own session must still lose to a
  // remote `crashed` one on a stale host.
  const rows = [
    view({ pane: asPaneId("%idle"), activity: "stopped" }),
    asked("%blocked", "blocked", NOW - 60_000),
    view({ pane: asPaneId("%run"), activity: "running", updated_at: NOW }),
    asked("%done", "done", NOW - 60_000),
    view({
      pane: asPaneId("%crash"),
      attention: at(["crashed"], NOW - 60_000),
      updated_at: NOW - 60_000,
      local: false,
      freshness: "stale",
      host: "elsewhere",
    }),
  ];

  expect(viewSort(rows, { now: NOW }).map((row) => row.pane)).toEqual([
    "%crash",
    "%blocked",
    "%done",
    "%run",
    "%idle",
  ]);
});

test("a request for a human sorts OLDEST first, because waiting is what makes it urgent", () => {
  // The bug this table exists to fix. One rule -- newest first -- served every
  // state, so an agent blocked forty minutes ago sat below one blocked thirty
  // seconds ago: the list a human opens to unblock things put the longest wait
  // at the bottom, and it sank further every time a newer request arrived.
  const rows = [
    asked("%recent", "blocked", NOW - 30_000),
    asked("%starving", "blocked", NOW - 40 * 60_000),
    asked("%middle", "blocked", NOW - 5 * 60_000),
  ];

  expect(viewSort(rows, { now: NOW }).map((row) => row.pane)).toEqual([
    "%starving",
    "%middle",
    "%recent",
  ]);

  // Same for `crashed`, the other kind only a human can answer.
  const crashes = [
    asked("%new-crash", "crashed", NOW - 30_000),
    asked("%old-crash", "crashed", NOW - 40 * 60_000),
  ];
  expect(viewSort(crashes, { now: NOW }).map((row) => row.pane)).toEqual([
    "%old-crash",
    "%new-crash",
  ]);
});

test("a finished agent sorts NEWEST first, because a result is news", () => {
  // The other direction, and the reason the direction is a table rather than a
  // constant. `done` does not starve: the freshest result is the one you have
  // not seen, and this morning's is the one you have.
  const rows = [
    asked("%old-done", "done", NOW - 40 * 60_000),
    asked("%fresh-done", "done", NOW - 30_000),
  ];

  expect(viewSort(rows, { now: NOW }).map((row) => row.pane)).toEqual(["%fresh-done", "%old-done"]);
});

test("a row is aged by the kind it RENDERS as, not by the newest thing on the pane", () => {
  // `updated_at` is the max over every fact on a pane, so a pane that crashed an
  // hour ago and printed a `done` a second ago carried a one-second age into a
  // band sorted oldest-first -- and sorted as the freshest crash on the fleet,
  // below every genuine one. The rendered kind's own `requested_at` is the only
  // number that answers "how long has THIS been true".
  const masked = view({
    pane: asPaneId("%masked"),
    attention: [
      { kind: "crashed", requested_at: NOW - 60 * 60_000 },
      { kind: "done", requested_at: NOW - 1_000 },
    ],
    updated_at: NOW - 1_000,
  });
  const plain = asked("%plain", "crashed", NOW - 30 * 60_000);

  expect(renderState(masked)).toBe("crashed");
  expect(viewSort([plain, masked], { now: NOW }).map((row) => row.pane)).toEqual([
    "%masked",
    "%plain",
  ]);
});

test("two kinds on one pane outrank one, at equal age", () => {
  // A pane that crashed AND was flagged blocked is two requests deep and the
  // pile was invisible to the sort: the array's length is a fact already in the
  // snapshot, and it says this pane has more wrong with it than its neighbour.
  const piled = view({
    pane: asPaneId("%piled"),
    attention: at(["crashed", "blocked"], NOW - 5 * 60_000),
    updated_at: NOW - 5 * 60_000,
  });
  const single = asked("%single", "crashed", NOW - 5 * 60_000);

  expect(viewSort([single, piled], { now: NOW }).map((row) => row.pane)).toEqual([
    "%piled",
    "%single",
  ]);

  // A nudge, never an override: the pile is worth minutes, and age is unbounded,
  // so a row that has genuinely been waiting far longer still leads.
  const starving = asked("%starving", "crashed", NOW - 90 * 60_000);
  expect(viewSort([piled, starving], { now: NOW }).map((row) => row.pane)).toEqual([
    "%starving",
    "%piled",
  ]);
});

test("the pane the reader is sitting in sorts LAST in its band", () => {
  // You do not need a picker to reach the pane your cursor is already in -- and
  // it was reliably at the top, being the pane that most recently said
  // something. Categorical rather than scored: no age makes your own pane worth
  // jumping to.
  const rows = [
    asked("%here", "blocked", NOW - 90 * 60_000),
    asked("%other", "blocked", NOW - 60_000),
  ];

  expect(viewSort(rows, { now: NOW, here: "%here" }).map((row) => row.pane)).toEqual([
    "%other",
    "%here",
  ]);
  // With no reader position, the ordinary age rule decides.
  expect(viewSort(rows, { now: NOW }).map((row) => row.pane)).toEqual(["%here", "%other"]);

  // Matched on the WHOLE address. A pane id is unique per node and nothing more,
  // so a remote `%here` is a different pane and must not be demoted.
  const remote = view({
    pane: asPaneId("%here"),
    host: "elsewhere",
    local: false,
    attention: at(["blocked"], NOW - 90 * 60_000),
    updated_at: NOW - 90 * 60_000,
  });
  expect(
    viewSort([rows[1] as PaneView, remote], { now: NOW, here: "%here" }).map((row) => row.pane),
  ).toEqual(["%here", "%other"]);
});

test("a stale host's rows sort below every fresh row in the same band", () => {
  // A stale row keeps its last-known fields and may be hours dead, so a fresh
  // row we can still vouch for is reached first. Categorical, not scored:
  // scoring it would let an ever-growing age on an unreachable host outrun every
  // fact we can verify -- an abandoned laptop would own the top of the list
  // forever, and it grows more convincing the longer it stays gone.
  const stale = view({
    pane: asPaneId("%stale"),
    host: "gone",
    local: false,
    freshness: "stale",
    attention: at(["blocked"], NOW - 90 * 60_000),
    updated_at: NOW - 90 * 60_000,
  });
  const fresh = asked("%fresh", "blocked", NOW - 60_000);

  expect(viewSort([stale, fresh], { now: NOW }).map((row) => row.pane)).toEqual([
    "%fresh",
    "%stale",
  ]);
  // And it does not cross a band either way: a stale `crashed` still leads a
  // fresh `blocked`.
  const staleCrash = { ...stale, attention: at(["crashed"], NOW - 60_000) };
  expect(viewSort([fresh, staleCrash], { now: NOW }).map((row) => row.pane)).toEqual([
    "%stale",
    "%fresh",
  ]);
});

test("rows in the stream the reader is working in lead, at comparable age", () => {
  // The reader's stream is resolved FROM the list -- whatever the row for their
  // own pane says -- rather than passed in, so it cannot disagree with the
  // `stream` column the picker prints beside it.
  const mine = view({
    pane: asPaneId("%here"),
    workstream: "api",
    activity: "running",
    updated_at: NOW,
  });
  const sameStream = view({
    pane: asPaneId("%same"),
    workstream: "api",
    attention: at(["blocked"], NOW - 60_000),
    updated_at: NOW - 60_000,
  });
  const otherStream = view({
    pane: asPaneId("%other"),
    workstream: "docs",
    attention: at(["blocked"], NOW - 5 * 60_000),
    updated_at: NOW - 5 * 60_000,
  });

  expect(
    viewSort([otherStream, sameStream, mine], { now: NOW, here: "%here" }).map((row) => row.pane),
  ).toEqual(["%same", "%other", "%here"]);

  // Still a nudge: four minutes of adjacency does not outweigh an hour of
  // waiting.
  const starving = { ...otherStream, attention: at(["blocked"], NOW - 60 * 60_000) };
  expect(
    viewSort([sameStream, starving], { now: NOW, here: "%here" }).map((row) => row.pane),
  ).toEqual(["%other", "%same"]);
});

test("a local row leads an identical remote one, because a jump there is a keypress", () => {
  const local = asked("%local", "blocked", NOW - 5 * 60_000);
  const remote = {
    ...local,
    pane: asPaneId("%remote"),
    host: "elsewhere",
    local: false,
  };

  expect(viewSort([remote, local], { now: NOW }).map((row) => row.pane)).toEqual([
    "%local",
    "%remote",
  ]);
});

test("viewSort leaves its input alone, so a caller may sort a shared list twice", () => {
  const rows = [
    view({ pane: asPaneId("%a") }),
    view({ pane: asPaneId("%b"), attention: at(["done"]) }),
  ];
  const before = rows.map((row) => row.pane);

  viewSort(rows);

  expect(rows.map((row) => row.pane)).toEqual(before);
});

test("a row that never said when sorts last in its band, in BOTH age directions", () => {
  // Unknown is not new, and -- the half the old single rule could not express --
  // unknown is not urgent either. Under oldest-first a missing timestamp read as
  // 1970 and won the entire list, so the sentinel is `-Infinity` against the
  // scored direction rather than a zero that means different things per band.
  const rows = [
    view({ pane: asPaneId("%unknown"), activity: "running", updated_at: null }),
    view({ pane: asPaneId("%known"), activity: "running", updated_at: NOW - 60_000 }),
  ];
  expect(viewSort(rows, { now: NOW }).map((row) => row.pane)).toEqual(["%known", "%unknown"]);

  // Two of them tie on an unscoreable urgency, and the address still separates
  // them -- `-Infinity - -Infinity` is NaN, which orders nothing and would hand
  // the position back to the input order this function exists to remove.
  const left = view({ pane: asPaneId("%1"), activity: "running", updated_at: null });
  const right = view({ pane: asPaneId("%2"), activity: "running", updated_at: null });
  expect(viewSort([left, right], { now: NOW }).map((row) => row.pane)).toEqual(["%1", "%2"]);
  expect(viewSort([right, left], { now: NOW }).map((row) => row.pane)).toEqual(["%1", "%2"]);
});

test("ordering is TOTAL: equal state and equal age break on host and pane, both directions", () => {
  // Two panes that tie on state and on `updated_at` are common -- a crashed pair
  // reconciled in one transaction shares a `requested_at` exactly -- and
  // Array.prototype.sort is only stable with respect to the INPUT order, so a
  // tie left unbroken makes the list depend on the order the store happened to
  // return. A status bar that reshuffles between two identical ticks is the
  // visible symptom; a picker whose rows move under a keypress is the harmful
  // one.
  const crashed = at(["crashed"], 7);
  const left = view({ host: "alpha", pane: asPaneId("%1"), attention: crashed, updated_at: 7 });
  const right = view({ host: "beta", pane: asPaneId("%2"), attention: crashed, updated_at: 7 });

  expect(viewSort([left, right]).map((row) => row.pane)).toEqual(["%1", "%2"]);
  expect(viewSort([right, left]).map((row) => row.pane)).toEqual(["%1", "%2"]);

  // Same host, so the pane id is what decides.
  const twin = view({ host: "alpha", pane: asPaneId("%9"), attention: crashed, updated_at: 7 });
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
