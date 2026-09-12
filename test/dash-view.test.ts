import { expect, test } from "vitest";
import { type DashPrefs, DEFAULT_DASH_PREFS } from "../src/dash-prefs.js";
import { dashRows, dashSort, dashVisible } from "../src/dash-view.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { isVisible } from "../src/paint.js";
import { type PaneView, viewSort } from "../src/view.js";

/**
 * Which rows the dash paints, and in what order.
 *
 * The filter is three independent gates and the sort is three named orders, so
 * the tests here are about the gates COMPOSING and the orders being total --
 * the underlying rules (`isVisible`, `viewSort`, `renderState`) have their own
 * tests and are not re-derived here.
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
    activity: "running",
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
    attached_pane: null,
    ...over,
  };
}

function prefs(over: Partial<DashPrefs> = {}): DashPrefs {
  return { ...DEFAULT_DASH_PREFS, hidden_states: [], ...over };
}

test("crew rows are hidden unless prefs.crew, and agree with isVisible", () => {
  const worker = view({ driver: "orchestrated" });
  expect(dashVisible(worker, prefs())).toBe(false);
  expect(dashVisible(worker, prefs())).toBe(isVisible(worker));
  expect(dashVisible(worker, prefs({ crew: true }))).toBe(true);
});

test("a crew row that needs a human stays visible with crew off", () => {
  const blocked = view({
    driver: "orchestrated",
    attention: [{ kind: "blocked", requested_at: 500, message: "which approach?" }],
  });
  expect(dashVisible(blocked, prefs())).toBe(true);
});

test("hide_stale drops rows from a stale host", () => {
  const row = view({ freshness: "stale", local: false });
  expect(dashVisible(row, prefs())).toBe(true);
  expect(dashVisible(row, prefs({ hide_stale: true }))).toBe(false);
});

test("hidden_states drops rows by rendered state, not by activity", () => {
  const done = view({
    activity: "running",
    attention: [{ kind: "done", requested_at: 900, message: "" }],
  });
  expect(dashVisible(done, prefs({ hidden_states: ["done"] }))).toBe(false);
  // It renders `done`, so hiding `running` must not touch it.
  expect(dashVisible(done, prefs({ hidden_states: ["running"] }))).toBe(true);
  expect(dashVisible(view({ activity: "running" }), prefs({ hidden_states: ["running"] }))).toBe(
    false,
  );
});

test("the gates compose: crew on still respects hide_stale", () => {
  const row = view({ driver: "orchestrated", freshness: "stale", local: false });
  expect(dashVisible(row, prefs({ crew: true }))).toBe(true);
  expect(dashVisible(row, prefs({ crew: true, hide_stale: true }))).toBe(false);
});

test("sort priority matches viewSort", () => {
  const now = 10_000;
  const rows = [
    view({ pane: asPaneId("%1"), activity: "stopped" }),
    view({
      pane: asPaneId("%2"),
      attention: [{ kind: "blocked", requested_at: 1_000, message: "" }],
    }),
    view({
      pane: asPaneId("%3"),
      attention: [{ kind: "crashed", requested_at: 2_000, message: "" }],
    }),
  ];
  expect(dashSort(rows, prefs({ sort: "priority" }), now).map((row) => row.pane)).toEqual(
    viewSort(rows, { now }).map((row) => row.pane),
  );
});

test("sort node groups rows by host, then by state, then by pane", () => {
  const rows = [
    view({ host: "beta", pane: asPaneId("%9"), activity: "stopped" }),
    view({ host: "alpha", pane: asPaneId("%2"), activity: "stopped" }),
    view({
      host: "beta",
      pane: asPaneId("%1"),
      attention: [{ kind: "blocked", requested_at: 1, message: "" }],
    }),
    view({ host: "alpha", pane: asPaneId("%1"), activity: "stopped" }),
  ];
  expect(dashSort(rows, prefs({ sort: "node" })).map((row) => `${row.host}${row.pane}`)).toEqual([
    "alpha%1",
    "alpha%2",
    "beta%1",
    "beta%9",
  ]);
});

test("sort age is newest first, nulls last, pane as tiebreak", () => {
  const rows = [
    view({ pane: asPaneId("%1"), updated_at: 100 }),
    view({ pane: asPaneId("%2"), updated_at: null }),
    view({ pane: asPaneId("%3"), updated_at: 900 }),
    view({ pane: asPaneId("%4"), updated_at: 900 }),
    view({ pane: asPaneId("%0"), updated_at: null }),
  ];
  expect(dashSort(rows, prefs({ sort: "age" })).map((row) => row.pane)).toEqual([
    "%3",
    "%4",
    "%1",
    "%0",
    "%2",
  ]);
});

test("every sort leaves the input array untouched", () => {
  const rows = [view({ pane: asPaneId("%2") }), view({ pane: asPaneId("%1") })];
  const before = rows.map((row) => row.pane);
  for (const sort of ["priority", "node", "age"] as const) dashSort(rows, prefs({ sort }));
  expect(rows.map((row) => row.pane)).toEqual(before);
});

test("dashRows filters then sorts", () => {
  const rows = [
    view({ host: "beta", pane: asPaneId("%1"), activity: "stopped" }),
    view({ host: "alpha", pane: asPaneId("%2"), driver: "orchestrated" }),
    view({ host: "alpha", pane: asPaneId("%3"), activity: "stopped" }),
  ];
  expect(dashRows(rows, prefs({ sort: "node" })).map((row) => `${row.host}${row.pane}`)).toEqual([
    "alpha%3",
    "beta%1",
  ]);
});
