import { expect, test } from "vitest";
import { type DashPrefs, DEFAULT_DASH_PREFS } from "../src/dash-prefs.js";
import {
  dashCrewCount,
  dashMatches,
  dashRows,
  dashSearchText,
  dashSort,
  dashStateCount,
  dashVisible,
} from "../src/dash-view.js";
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
    server: { kind: "default" },
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
    model: null,
    provider: null,
    effort: null,
    provider_effort: null,
    context_pct: null,
    context_tokens: null,
    context_window: null,
    usage: null,
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

test("header state counts include every crew state only when crew is on", () => {
  const counts = {
    crashed: 0,
    blocked: 0,
    done: 1,
    running: 2,
    idle: 0,
  };
  const orchestrated_counts = {
    crashed: 1,
    blocked: 2,
    done: 3,
    running: 4,
    idle: 5,
  };
  const status = { counts, orchestrated_counts };

  expect(dashStateCount(status, "running", false)).toBe(2);
  expect(dashStateCount(status, "running", true)).toBe(6);
  expect(dashStateCount(status, "done", true)).toBe(4);
  expect(dashStateCount(status, "idle", true)).toBe(5);
  expect(dashStateCount(status, "blocked", false)).toBe(2);
  expect(dashStateCount(status, "crashed", false)).toBe(1);
  expect(dashCrewCount(status)).toBe(15);
});

test("crew rows are hidden unless prefs.crew, and agree with isVisible", () => {
  const worker = view({ driver: "orchestrated" });
  expect(dashVisible(worker, prefs())).toBe(false);
  expect(dashVisible(worker, prefs())).toBe(isVisible(worker));
  expect(dashVisible(worker, prefs({ crew: true }))).toBe(true);
});

test("a crew row that needs a human stays visible with crew off", () => {
  const blocked = view({
    driver: "orchestrated",
    model: null,
    provider: null,
    effort: null,
    provider_effort: null,
    context_pct: null,
    context_tokens: null,
    context_window: null,
    usage: null,
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

test("sort node puts here first, then hosts A-Z, then state, then pane", () => {
  const rows = [
    view({ host: "beta", local: false, pane: asPaneId("%9"), activity: "stopped" }),
    view({ host: "alpha", local: false, pane: asPaneId("%2"), activity: "stopped" }),
    view({
      host: "beta",
      local: false,
      pane: asPaneId("%1"),
      attention: [{ kind: "blocked", requested_at: 1, message: "" }],
    }),
    view({ host: "zeta", local: true, pane: asPaneId("%3"), activity: "stopped" }),
    view({ host: "alpha", local: false, pane: asPaneId("%1"), activity: "stopped" }),
    view({ host: "here", local: true, pane: asPaneId("%1"), activity: "stopped" }),
  ];
  expect(dashSort(rows, prefs({ sort: "node" })).map((row) => `${row.host}${row.pane}`)).toEqual([
    "here%1",
    "zeta%3",
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

test("the searchable text is name, workstream, session, host and rendered state", () => {
  const row = view({
    agent_name: "Worker-1",
    workstream: "DashSearch",
    session_name: "hacking/murmur",
    host: "Devbox",
    local: false,
    activity: "running",
  });
  const text = dashSearchText(row);
  for (const field of ["worker-1", "dashsearch", "hacking/murmur", "devbox", "running"]) {
    expect(text).toContain(field);
  }
});

test("a row with no agent_name is still searchable by the name the card paints", () => {
  // `agentLabel` falls back to pi_session, then window_name, then the session
  // leaf. Searching the raw `agent_name` alone would make an adopted pane --
  // the common case for a human's own shell -- unfindable by the only name it
  // ever shows.
  const adopted = view({ agent_name: null, pi_session: null, window_name: "scratchpad" });
  expect(dashSearchText(adopted)).toContain("scratchpad");
  expect(dashMatches(adopted, "scratch")).toBe(true);

  const bySession = view({ agent_name: null, pi_session: "review/tick", window_name: null });
  expect(dashMatches(bySession, "review/tick")).toBe(true);
});

test("matching is case-insensitive, literal, and not fuzzy", () => {
  const row = view({ agent_name: "worker-1", workstream: "dash-search" });
  expect(dashMatches(row, "WORKER")).toBe(true);
  expect(dashMatches(row, "dash-sea")).toBe(true);
  // Literal: the subsequence a fuzzy matcher would accept must not match.
  expect(dashMatches(row, "wrkr")).toBe(false);
  expect(dashMatches(row, "nope")).toBe(false);
});

test("an empty or blank query matches every row", () => {
  const row = view({ agent_name: "worker-1" });
  expect(dashMatches(row, "")).toBe(true);
  expect(dashMatches(row, "   ")).toBe(true);
});

test("a query matches the rendered state word, not the raw activity", () => {
  const done = view({
    activity: "running",
    attention: [{ kind: "done", requested_at: 900, message: "" }],
  });
  expect(dashMatches(done, "done")).toBe(true);
  expect(dashMatches(done, "running")).toBe(false);
});

test("the query composes with the crew, stale and state gates", () => {
  const rows = [
    view({ pane: asPaneId("%1"), agent_name: "alpha", driver: "orchestrated" }),
    view({ pane: asPaneId("%2"), agent_name: "alpha", freshness: "stale", local: false }),
    view({ pane: asPaneId("%3"), agent_name: "alpha" }),
    view({ pane: asPaneId("%4"), agent_name: "beta" }),
  ];

  // Crew off hides %1 even though it matches; the query hides %4 even though
  // every gate passes it.
  expect(dashRows(rows, prefs({ sort: "node" }), 0, "alpha").map((row) => row.pane)).toEqual([
    "%3",
    "%2",
  ]);
  expect(dashRows(rows, prefs({ sort: "node", crew: true }), 0, "alpha").map((row) => row.pane)) //
    .toEqual(["%1", "%3", "%2"]);
  expect(
    dashRows(rows, prefs({ sort: "node", hide_stale: true }), 0, "alpha").map((row) => row.pane),
  ).toEqual(["%3"]);
  expect(dashRows(rows, prefs({ sort: "node", hidden_states: ["running"] }), 0, "alpha")).toEqual(
    [],
  );
});

test("dashRows without a query is unchanged", () => {
  const rows = [view({ pane: asPaneId("%1") }), view({ pane: asPaneId("%2") })];
  expect(dashRows(rows, prefs(), 0, "").map((row) => row.pane)).toEqual(
    dashRows(rows, prefs(), 0).map((row) => row.pane),
  );
});

test("dashRows filters then sorts", () => {
  const rows = [
    view({ host: "beta", local: false, pane: asPaneId("%1"), activity: "stopped" }),
    view({ host: "alpha", local: false, pane: asPaneId("%2"), driver: "orchestrated" }),
    view({ host: "alpha", local: false, pane: asPaneId("%3"), activity: "stopped" }),
    view({ host: "here", local: true, pane: asPaneId("%4"), activity: "stopped" }),
  ];
  expect(dashRows(rows, prefs({ sort: "node" })).map((row) => `${row.host}${row.pane}`)).toEqual([
    "here%4",
    "alpha%3",
    "beta%1",
  ]);
});
