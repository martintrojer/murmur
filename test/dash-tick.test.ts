import { expect, test } from "vitest";
import {
  cardSummary,
  cardWindow,
  dashFooterHints,
  dashNavigation,
  fetchedText,
  fitFooterHints,
  formatFetchedAge,
  glanceNeedsRefresh,
  glanceViewport,
  hintsWidth,
  moveIndex,
  paneFingerprint,
  scrollLabel,
  summaryTargets,
} from "../src/dash-tick.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import type { Status } from "../src/status.js";
import type { PaneView } from "../src/view.js";

function pane(overrides: Partial<PaneView> = {}): PaneView {
  return {
    host_id: "host-1",
    host: "here",
    local: true,
    pane: asPaneId("%1"),
    session: asSessionId("$1"),
    window: asWindowId("@1"),
    session_name: "work",
    window_name: "agent",
    activity: "running",
    attention: [],
    freshness: "fresh",
    agent_id: "agent-1",
    agent_name: "worker-1",
    pi_session: null,
    workstream: "dash",
    role: "worker",
    cli: "pi",
    driver: "human",
    updated_at: 1_000,
    snapshot_at: null,
    fetched_at: null,
    attached_pane: null,
    ...overrides,
  };
}

test("equal panes have equal fingerprints", () => {
  expect(paneFingerprint(pane())).toBe(paneFingerprint(pane()));
});

test("updated time and attention messages change the pane fingerprint", () => {
  const original = pane();
  expect(paneFingerprint(pane({ updated_at: 2_000 }))).not.toBe(paneFingerprint(original));
  expect(
    paneFingerprint(
      pane({ attention: [{ kind: "blocked", requested_at: 500, message: "choose one" }] }),
    ),
  ).not.toBe(
    paneFingerprint(
      pane({ attention: [{ kind: "blocked", requested_at: 500, message: "choose two" }] }),
    ),
  );
});

test("glance refreshes only for a new non-null fingerprint", () => {
  expect(glanceNeedsRefresh(null, "a")).toBe(true);
  expect(glanceNeedsRefresh("a", "a")).toBe(false);
  expect(glanceNeedsRefresh("a", "b")).toBe(true);
  expect(glanceNeedsRefresh("a", null)).toBe(false);
});

test("fetched age speaks in seconds so the header can tick", () => {
  expect(formatFetchedAge(0)).toBe("fetched just now");
  expect(formatFetchedAge(999)).toBe("fetched just now");
  expect(formatFetchedAge(1_000)).toBe("fetched 1s ago");
  expect(formatFetchedAge(3_000)).toBe("fetched 3s ago");
  expect(formatFetchedAge(59_000)).toBe("fetched 59s ago");
  expect(formatFetchedAge(60_000)).toBe("fetched 1m ago");
});

test("fetchedText picks the oldest peer fetch", () => {
  const peer = (
    overrides: Partial<Status["peers"][number]> &
      Pick<Status["peers"][number], "name" | "fetched_at">,
  ): Status["peers"][number] => ({
    target: overrides.name,
    display_name: null,
    snapshot_at: null,
    last_error: null,
    stale: false,
    needs_session: false,
    ...overrides,
  });

  // A peerless node still has a clock. `local` alone was a CONSTANT: on a
  // machine with no peers the header's one ticking field never moved, so the
  // dash looked frozen and gave the reader nothing to tell a live collect loop
  // from a wedged one -- which is the whole job of that field.
  //
  // The refresh age is the honest counter there: nothing is fetched, but the
  // collect cycle still runs, and its age is what "is this still alive" asks.
  expect(fetchedText({ peers: [] }, 10_000, 10_000)).toBe("local · refreshed just now");
  expect(fetchedText({ peers: [] }, 10_000, 7_000)).toBe("local · refreshed 3s ago");
  // A clock that went backwards (suspend, NTP step) reads as now, not as a
  // negative age: `formatFetchedAge` clamps, and the header must not print
  // `refreshed -60s ago`.
  expect(fetchedText({ peers: [] }, 10_000, 70_000)).toBe("local · refreshed just now");
  // No refresh has completed yet, so there is no age to state.
  expect(fetchedText({ peers: [] }, 10_000, null)).toBe("local");
  expect(fetchedText({ peers: [peer({ name: "a", fetched_at: null })] }, 10_000)).toBe(
    "fetched never",
  );
  expect(
    fetchedText(
      {
        peers: [peer({ name: "a", fetched_at: 9_000 }), peer({ name: "b", fetched_at: 7_000 })],
      },
      10_000,
    ),
  ).toBe("fetched 3s ago");
});

test("moveIndex wraps for j/k and clamps for page jumps", () => {
  expect(moveIndex(0, -1, 5, "wrap")).toBe(4);
  expect(moveIndex(4, 1, 5, "wrap")).toBe(0);
  expect(moveIndex(1, -3, 5, "clamp")).toBe(0);
  expect(moveIndex(1, 10, 5, "clamp")).toBe(4);
});

test("cardWindow keeps selection mid-list and reports overflow", () => {
  expect(cardWindow(0, 10, 3)).toEqual({ first: 0, shown: 3, above: 0, below: 7 });
  expect(cardWindow(5, 10, 3)).toEqual({ first: 4, shown: 3, above: 4, below: 3 });
  expect(cardWindow(9, 10, 3)).toEqual({ first: 7, shown: 3, above: 7, below: 0 });
  expect(cardWindow(1, 2, 5)).toEqual({ first: 0, shown: 2, above: 0, below: 0 });
});

test("scrollLabel is silent when everything fits", () => {
  expect(scrollLabel({ first: 0, shown: 3, above: 0, below: 0, total: 3 })).toBeNull();
  expect(scrollLabel({ first: 2, shown: 3, above: 2, below: 5, total: 10 })).toBe("↑2 3–5/10 ↓5");
  expect(scrollLabel({ first: 0, shown: 3, above: 0, below: 7, total: 10 })).toBe("1–3/10 ↓7");
  expect(scrollLabel({ first: 7, shown: 3, above: 7, below: 0, total: 10 })).toBe("↑7 8–10/10");
});

test("glanceViewport reserves a chrome row only when content overflows", () => {
  expect(glanceViewport(5, 10)).toEqual({ visible: 8, chrome: false });
  expect(glanceViewport(20, 10)).toEqual({ visible: 7, chrome: true });
  expect(glanceViewport(0, 3)).toEqual({ visible: 1, chrome: false });
});

test("fitFooterHints drops low-priority items before wrapping", () => {
  const hints = dashFooterHints({ sort: "priority", hide_stale: false, crew: true });
  const wide = fitFooterHints(hints, 200);
  expect(wide).toHaveLength(hints.length);
  expect(hintsWidth(wide)).toBeLessThanOrEqual(200);

  const mid = fitFooterHints(hints, 72);
  expect(hintsWidth(mid)).toBeLessThanOrEqual(72);
  expect(mid.some((hint) => hint.chord === "j/k")).toBe(true);
  expect(mid.some((hint) => hint.chord === "q")).toBe(true);
  expect(mid.some((hint) => hint.chord === "+/-")).toBe(false);

  const tight = fitFooterHints(hints, 36);
  expect(hintsWidth(tight)).toBeLessThanOrEqual(36);
  expect(tight.every((hint) => hint.label === "" || hintsWidth(tight) <= 36)).toBe(true);
  expect(tight[0]?.chord).toBe("j/k");
});

test("dash footer makes input mode and region focus discoverable", () => {
  const hints = dashFooterHints({ sort: "priority", hide_stale: false, crew: true }, "cards");
  expect(hints.some((hint) => hint.chord === "i" && hint.label === "input")).toBe(true);
  expect(hints.some((hint) => hint.chord === "tab" && hint.value === "cards")).toBe(true);

  const preview = dashFooterHints({ sort: "priority", hide_stale: false, crew: true }, "preview");
  expect(preview.some((hint) => hint.chord === "tab" && hint.value === "preview")).toBe(true);
  expect(preview.some((hint) => hint.chord === "j/k" && hint.label === "scroll")).toBe(true);
});

test("navigation keys map to the active region", () => {
  expect(dashNavigation("cards", "down", 4, 2)).toEqual({ type: "cards", offset: 1 });
  expect(dashNavigation("cards", "pageDown", 4, 2)).toEqual({ type: "cards", offset: 4 });
  expect(dashNavigation("preview", "down", 4, 2)).toEqual({ type: "preview", offset: 1 });
  expect(dashNavigation("preview", "pageDown", 4, 2)).toEqual({ type: "preview", offset: 2 });
  expect(dashNavigation("preview", "home", 4, 2)).toEqual({ type: "preview-edge", edge: "top" });
  expect(dashNavigation("cards", "end", 4, 2)).toEqual({ type: "cards-edge", edge: "bottom" });
});

/**
 * Which cards get their own glance for the summary line.
 *
 * The card summary used to be passed only for the SELECTED pane, so the model /
 * effort / context line appeared on one card and every other card showed a
 * blank third row. The fact is per-agent and wanted on all of them.
 *
 * Local only, and that is the whole rule: a local capture is a ~2ms
 * `capture-pane` against the tmux server on this machine, while a remote one is
 * an ssh -- measured at ~1.5s to fail against an unreachable peer. Capturing
 * every visible remote card once a second would put the dash's redraw behind a
 * network round-trip per row, which is the cost control `glance` already pays
 * for the preview.
 */
test("card summaries are captured for visible local panes only", () => {
  const here = pane({ pane: asPaneId("%1") });
  const there = pane({ pane: asPaneId("%2"), local: false, host: "bubba" });
  const alsoHere = pane({ pane: asPaneId("%3") });

  expect(summaryTargets([here, there, alsoHere])).toEqual([here, alsoHere]);
  expect(summaryTargets([there])).toEqual([]);
  expect(summaryTargets([])).toEqual([]);
});

test("the selected remote pane still gets a summary, from the preview it already paid for", () => {
  // The preview's glance is fetched for the selected pane regardless, so the
  // card can reuse that text for free. This keeps the one remote card a reader
  // is actually looking at from being the only blank one.
  const there = pane({ pane: asPaneId("%2"), local: false, host: "bubba" });
  expect(summaryTargets([there], there)).toEqual([]);
  expect(cardSummary(there, there, new Map(), "model-x · medium · 5%")).toBe(
    "model-x · medium · 5%",
  );
});

test("a card summary prefers its own capture over the selected pane's glance", () => {
  // Two sources, and the per-card one wins where it exists: the selected
  // pane's glance belongs to the selected pane, and using it for another card
  // would show one agent's state on another's row.
  const here = pane({ pane: asPaneId("%1") });
  const other = pane({ pane: asPaneId("%3") });
  const captures = new Map([
    [`${here.host_id}:${here.pane}`, "mine · high · 1%"],
    [`${other.host_id}:${other.pane}`, "theirs · low · 2%"],
  ]);

  expect(cardSummary(here, other, captures, "selected glance")).toBe("mine · high · 1%");
  expect(cardSummary(other, other, captures, "selected glance")).toBe("theirs · low · 2%");
  // No capture and not selected: nothing to say rather than another pane's line.
  expect(cardSummary(pane({ pane: asPaneId("%9") }), other, captures, "selected glance")).toBe(
    undefined,
  );
});
