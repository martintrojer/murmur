import { expect, test } from "vitest";
import { visibleWidth } from "../src/ansi.js";
import {
  cardWindow,
  clipGlanceLine,
  compactRow,
  compactRowLayout,
  compactSelectionMarker,
  dashFooterHints,
  dashHelpSections,
  dashInputFocus,
  dashNavigation,
  dashVisibleCards,
  fetchedText,
  formatFetchedAge,
  glanceNeedsRefresh,
  glanceViewport,
  moveIndex,
  paneFingerprint,
  routeDashKey,
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
    server: { kind: "default" },
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
  expect(formatFetchedAge(0)).toBe("stalest fetch just now");
  expect(formatFetchedAge(999)).toBe("stalest fetch just now");
  expect(formatFetchedAge(1_000)).toBe("stalest fetch 1s ago");
  expect(formatFetchedAge(3_000)).toBe("stalest fetch 3s ago");
  expect(formatFetchedAge(59_000)).toBe("stalest fetch 59s ago");
  expect(formatFetchedAge(60_000)).toBe("stalest fetch 1m ago");
});

test("fetchedText labels worst-case peer freshness honestly", () => {
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
    "1 peer never fetched",
  );
  expect(
    fetchedText(
      {
        peers: [
          peer({ name: "a", fetched_at: 9_000 }),
          peer({ name: "b", fetched_at: null }),
          peer({ name: "c", fetched_at: null }),
        ],
      },
      10_000,
    ),
  ).toBe("2 peers never fetched");
  expect(
    fetchedText(
      {
        peers: [peer({ name: "a", fetched_at: 9_000 }), peer({ name: "b", fetched_at: 7_000 })],
      },
      10_000,
    ),
  ).toBe("stalest fetch 3s ago");
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

/** A neutral view state, for the tests that do not care about the values. */
const VIEW_STATE = { sort: "priority", crew: false, hideStale: false, compact: false } as const;

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

/**
 * The footer says only what the reader can do RIGHT NOW.
 *
 * The old line listed all thirteen chords and dropped them by rank as the
 * terminal narrowed, so the same key vanished or reappeared with the pane
 * width. Four fixed lines fit any pane worth running a dash in, and the full
 * legend moved into `?`.
 */
test("the footer is contextual and short enough never to need fitting", () => {
  const text = (mode: Parameters<typeof dashFooterHints>[0]) =>
    dashFooterHints(mode)
      .map((hint) => `${hint.chord} ${hint.label}`)
      .join(" · ");

  expect(text("normal")).toBe("/ filter · ? shortcuts");
  expect(text("filter-active")).toBe("esc clear · / edit · ? shortcuts");
  expect(text("filter-editing")).toBe("enter keep · esc clear");
  expect(text("input")).toBe("enter send · ^e stop · esc leave");
});

test("help lists every dashboard shortcut by category", () => {
  const sections = dashHelpSections(VIEW_STATE);
  expect(sections.map((section) => section.title)).toEqual([
    "navigation",
    "actions",
    "filter",
    "view",
    "prompt",
  ]);

  const chords = sections.flatMap((section) => section.hints.map((hint) => hint.chord));
  // Every chord `useInput` binds has to be discoverable here, since the footer
  // no longer names them.
  for (const chord of ["j/k", "^u/^d", "g/G", "tab", "enter", "i", "q", "^r", "/", "esc", "?", "c"])
    expect(chords).toContain(chord);
  expect(new Set(chords).size).toBe(chords.length);
});

/**
 * Help is MODAL, which is the whole reason it needs a seam of its own.
 *
 * `?` while help is open must close it rather than re-open it, and `q` must not
 * quit the dash from behind the panel -- a reader who opened help to find the
 * quit key should not lose the dash to the next keypress.
 */
test("an open help panel swallows every other dashboard key", () => {
  expect(routeDashKey(false, "?", {})).toBe("help-open");
  expect(routeDashKey(false, "q", {})).toBe("dash");
  expect(routeDashKey(false, "", { escape: true })).toBe("dash");

  expect(routeDashKey(true, "?", {})).toBe("help-close");
  expect(routeDashKey(true, "", { escape: true })).toBe("help-close");
  expect(routeDashKey(true, "q", {})).toBe("help-inert");
  expect(routeDashKey(true, "j", {})).toBe("help-inert");
  expect(routeDashKey(true, "", { return: true })).toBe("help-inert");
});

/**
 * Compact mode only pays for itself if the window grows with it.
 *
 * A bordered card costs five rows; a compact row costs one. Reusing the card
 * arithmetic in compact mode would paint the same handful of agents in a fifth
 * of the space and waste the rest, so the capacity has to know which row it is
 * counting.
 */
test("compact rows pack the rail far denser than bordered cards", () => {
  expect(dashVisibleCards(20, false)).toBe(4);
  expect(dashVisibleCards(20, true)).toBe(20);
  // Never zero, however little room is left: something must still be pickable.
  expect(dashVisibleCards(0, false)).toBe(1);
  expect(dashVisibleCards(0, true)).toBe(1);
});

/**
 * The rail paints "↑ N more" / "↓ N more" INSIDE its own fixed-height box, so
 * those rows have to be taken out of the capacity before the rows are counted.
 *
 * Compact mode makes the bug systematic rather than occasional: one row costs
 * one line, so the window uses the rail exactly, and any cue pushes the box's
 * children past its height at EVERY terminal size. Ink's default overflow is
 * visible, so a fixed-height TUI starts scrolling.
 */
test("the rail reserves room for its overflow cues", () => {
  // Everything fits: no cue is painted, so nothing is reserved.
  expect(dashVisibleCards(20, true, 20)).toBe(20);
  expect(dashVisibleCards(20, false, 4)).toBe(4);

  // Overflowing: two cue rows, the worst case, come off the top.
  expect(dashVisibleCards(20, true, 50)).toBe(18);
  // Bordered mode only overflowed when the height divided evenly by five, and
  // the remainder no longer hides it.
  expect(dashVisibleCards(20, false, 10)).toBe(3);
  expect(dashVisibleCards(22, false, 10)).toBe(4);

  // Still never zero.
  expect(dashVisibleCards(0, true, 9)).toBe(1);
  expect(dashVisibleCards(1, false, 9)).toBe(1);
});

/**
 * The footer used to report toggle STATE ("a crew on", "f stale on"); the
 * contextual footer reports none of it. With no indicator anywhere, a dash left
 * with crew-only on looks like a dash that lost its agents, so the panel -- the
 * one surface with room -- has to name the current value next to the key.
 */
test("help names the current value of every view toggle", () => {
  const values = (state: Parameters<typeof dashHelpSections>[0]) =>
    Object.fromEntries(
      dashHelpSections(state)
        .flatMap((section) => section.hints)
        .filter((hint) => hint.value !== undefined)
        .map((hint) => [hint.chord, hint.value]),
    );

  expect(values({ sort: "priority", crew: false, hideStale: false, compact: false })).toEqual({
    s: "priority",
    a: "all",
    f: "shown",
    c: "off",
  });
  expect(values({ sort: "age", crew: true, hideStale: true, compact: true })).toEqual({
    s: "age",
    a: "crew only",
    f: "hidden",
    c: "on",
  });
});

/**
 * Selected-and-focused vs selected-and-unfocused were two light purples apart,
 * which is a hue-only distinction on one borderless line -- unreadable on a
 * low-contrast or colour-blind terminal. A gutter glyph makes it structural.
 */
test("a compact row marks selection and focus in the gutter", () => {
  expect(compactSelectionMarker(true, true)).toBe("▸ ");
  expect(compactSelectionMarker(true, false)).toBe("· ");
  // Unselected rows still pay the gutter, so the text columns stay aligned.
  expect(compactSelectionMarker(false, true)).toBe("  ");
  expect(compactSelectionMarker(false, false)).toBe("  ");
});

const COMPACT_ROWS = [
  {
    state: "R",
    agent: "a",
    host: "here",
    stream: "dash",
    flags: "",
    age: "2m",
    summary: "short",
  },
  {
    state: "B",
    agent: "worker-eleven",
    host: "build-server",
    stream: "release",
    flags: "crew",
    age: "12m",
    summary: "waiting for input",
  },
] as const;

test("compact rows align fields of different lengths", () => {
  const layout = compactRowLayout(COMPACT_ROWS, 80);
  const lines = COMPACT_ROWS.map((row) => compactRow(row, layout, "  "));

  expect(lines[0]?.indexOf("here")).toBe(lines[1]?.indexOf("build-server"));
  expect(lines[0]?.indexOf("dash")).toBe(lines[1]?.indexOf("release"));
  expect(lines.every((line) => [...line].length === 80)).toBe(true);
});

test("compact column widths stay stable across visible windows and cap outliers", () => {
  const outlier = { ...COMPACT_ROWS[0], agent: "a".repeat(40), host: "h".repeat(30) };
  const layout = compactRowLayout([...COMPACT_ROWS, outlier], 100);

  expect(layout.widths.agent).toBe(24);
  expect(layout.widths.host).toBe(18);
  expect(COMPACT_ROWS.map((row) => compactRow(row, layout, "  "))[0]?.indexOf("here")).toBe(31);
  expect(COMPACT_ROWS.map((row) => compactRow(row, layout, "  "))[1]?.indexOf("build-server")).toBe(
    31,
  );
});

test("compact rows count characters rather than UTF-16 units", () => {
  const row = {
    state: "󰚩",
    agent: "bot",
    host: "",
    stream: "",
    flags: "",
    age: "",
    summary: "",
  };

  expect(compactRow(row, compactRowLayout([row], 10), "  ")).toBe("  󰚩  bot  ");
  expect([...compactRow(row, compactRowLayout([row], 10), "  ")]).toHaveLength(10);
});

test("compact rows drop extra fields before trimming the agent", () => {
  const row = {
    state: "R",
    agent: "agent",
    host: "host",
    stream: "stream",
    flags: "crew",
    age: "2m",
    summary: "summary text",
  };

  expect(compactRowLayout([row], 44)).toMatchObject({
    columns: ["host", "stream", "flags", "age"],
    summary: true,
  });
  expect(compactRowLayout([row], 43)).toMatchObject({
    columns: ["host", "stream", "flags", "age"],
    summary: false,
  });
  expect(compactRowLayout([row], 33).columns).toEqual(["host", "stream", "age"]);
  expect(compactRowLayout([row], 27).columns).toEqual(["host", "stream"]);
  expect(compactRowLayout([row], 23).columns).toEqual(["host"]);
  expect(compactRowLayout([row], 15).columns).toEqual([]);
  expect(compactRow({ ...row, agent: "agent-name" }, compactRowLayout([row], 9), "  ")).toBe(
    "  R  age…",
  );
});

test("navigation keys map to the active region", () => {
  expect(dashNavigation("cards", "down", 4, 2)).toEqual({ type: "cards", offset: 1 });
  expect(dashNavigation("cards", "pageDown", 4, 2)).toEqual({ type: "cards", offset: 4 });
  expect(dashNavigation("preview", "down", 4, 2)).toEqual({ type: "preview", offset: 1 });
  expect(dashNavigation("preview", "pageDown", 4, 2)).toEqual({ type: "preview", offset: 2 });
  expect(dashNavigation("preview", "home", 4, 2)).toEqual({ type: "preview-edge", edge: "top" });
  expect(dashNavigation("cards", "end", 4, 2)).toEqual({ type: "cards-edge", edge: "bottom" });
});

test("leaving input mode restores the focus it was opened from", () => {
  const fromCards = dashInputFocus({ focus: "cards", origin: null }, "enter");
  expect(fromCards).toEqual({ focus: "preview", origin: "cards" });
  expect(dashInputFocus(fromCards, "leave")).toEqual({ focus: "cards", origin: null });

  const fromPreview = dashInputFocus({ focus: "preview", origin: null }, "enter");
  expect(fromPreview).toEqual({ focus: "preview", origin: "preview" });
  expect(dashInputFocus(fromPreview, "leave")).toEqual({ focus: "preview", origin: null });
});

test("sending keeps input mode and its remembered origin", () => {
  const open = dashInputFocus({ focus: "cards", origin: null }, "enter");
  const sent = dashInputFocus(open, "send");
  expect(sent).toEqual({ focus: "preview", origin: "cards" });
  expect(dashInputFocus(sent, "leave")).toEqual({ focus: "cards", origin: null });
});

test("leaving without a remembered origin keeps the current focus", () => {
  expect(dashInputFocus({ focus: "preview", origin: null }, "leave")).toEqual({
    focus: "preview",
    origin: null,
  });
});

/**
 * Why the glance body is clipped before it reaches ink.
 *
 * ink memoises text measurement in a module-level `Map` keyed by the string
 * itself, with no eviction (`ink/build/measure-text.js`). Every distinct string
 * the renderer has ever seen is retained for the life of the process --
 * measured at ~0.24KB per line, surviving a forced GC.
 *
 * The dash feeds it an unbounded stream of distinct strings: the glance holds
 * 2000 lines of live `capture-pane` output and re-renders every second, so a
 * busy agent's scrolling pane produces new text indefinitely. Observed at 2.3GB
 * RSS after five and a half hours, climbing ~240MB/hour.
 *
 * Clipping to the pane width is what breaks the growth, because it also collapses
 * the variety: `wrap="truncate-end"` happens at PAINT time, so ink measures the
 * full 400-character line first and caches that. Clipped, two lines differing
 * only past the right-hand edge become one cache key.
 */
test("glance lines are clipped to the visible width before rendering", () => {
  // A line wider than the pane is cut, with room left for the ellipsis ink's
  // own truncation would add.
  const long = "x".repeat(400);
  expect(clipGlanceLine(long, 80).length).toBeLessThanOrEqual(80);
  // Two lines that differ only past the edge collapse to ONE cache key, which
  // is the property that bounds the cache rather than merely slowing it.
  expect(clipGlanceLine(`${"a".repeat(90)}FIRST`, 80)).toBe(
    clipGlanceLine(`${"a".repeat(90)}SECOND`, 80),
  );
  // A line that fits is returned unchanged -- no allocation, and no new cache
  // key for text ink has already measured.
  const short = "ready";
  expect(clipGlanceLine(short, 80)).toBe(short);
});

test("clipping keeps enough width to be useful and never zero", () => {
  // Defends the reader, not the renderer: a narrow terminal must still show
  // something, and a zero or negative width would blank the pane entirely.
  expect(clipGlanceLine("hello world", 0)).toBe("hello world");
  expect(clipGlanceLine("hello world", -5)).toBe("hello world");
  expect(clipGlanceLine("hello world", 4)).toBe("hell");
});

test("the card summary is clipped too, since it is also live pane text", () => {
  // The glance body was only half the source. A card's third row is
  // `oneLiner(pane, glanceLine)`, and for an agent that reports nothing that is
  // the last non-empty line of its pane -- which changes on every tick of a
  // working agent, exactly like the glance.
  //
  // Same cache, same unbounded growth, and clipping the glance alone left the
  // dash still climbing 130MB in 80 seconds when measured.
  const long = `status: ${"y".repeat(300)}`;
  expect(clipGlanceLine(long, 36).length).toBeLessThanOrEqual(36);
  expect(clipGlanceLine(`${"b".repeat(40)}ONE`, 36)).toBe(
    clipGlanceLine(`${"b".repeat(40)}TWO`, 36),
  );
});

test("glance clipping measures visible columns and keeps sequences whole", () => {
  // With `capture-pane -e` the glance body carries SGR, and clipping by
  // character index did two things wrong at once: it counted escape bytes
  // toward the width, so a coloured line was clipped far too short, and it cut
  // mid-sequence, so the terminal swallowed the rest of the line waiting for a
  // final byte.
  const styled = `\u001b[31m${"a".repeat(90)}\u001b[0m`;

  const clipped = clipGlanceLine(styled, 80);

  // Eighty visible columns, whatever the byte length.
  expect(visibleWidth(clipped)).toBe(80);
  // And it still collapses variety past the edge, which is why this clip
  // exists: ink's measurement cache never evicts.
  expect(clipGlanceLine(`\u001b[31m${"a".repeat(90)}FIRST`, 80)).toBe(
    clipGlanceLine(`\u001b[31m${"a".repeat(90)}SECOND`, 80),
  );
});

test("a compact row measures a styled summary by its visible width", () => {
  // The compact table lays out fixed columns from measured text. Scoring escape
  // bytes as width made a styled row's cells overflow their column and shear
  // every column to the right of it.
  const layout = compactRowLayout(
    [
      {
        state: "run",
        agent: "worker",
        host: "",
        stream: "",
        flags: "",
        age: "",
        summary: "\u001b[31mtests failed\u001b[0m",
      },
    ],
    60,
  );

  expect(layout.widths.agent).toBe(6);
  expect(
    visibleWidth(
      compactRow(
        {
          state: "run",
          agent: "worker",
          host: "",
          stream: "",
          flags: "",
          age: "",
          summary: "\u001b[31mtests failed\u001b[0m",
        },
        layout,
        " ",
      ),
    ),
  ).toBeLessThanOrEqual(60);
});
