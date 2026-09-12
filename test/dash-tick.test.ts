import { expect, test } from "vitest";
import {
  cardWindow,
  dashFooterHints,
  fetchedText,
  fitFooterHints,
  formatFetchedAge,
  glanceNeedsRefresh,
  glanceViewport,
  hintsWidth,
  moveIndex,
  paneFingerprint,
  scrollLabel,
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

  expect(fetchedText({ peers: [] }, 10_000)).toBe("local");
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

test("dash footer makes input mode discoverable", () => {
  const hints = dashFooterHints({ sort: "priority", hide_stale: false, crew: true });
  expect(hints.some((hint) => hint.chord === "i" && hint.label === "input")).toBe(true);
});
