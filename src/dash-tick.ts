import { clipToWidth, visibleWidth } from "./ansi.js";
import type { DashSort } from "./dash-prefs.js";
import type { Status } from "./status.js";
import { age, type PaneView } from "./view.js";

export function paneFingerprint(pane: PaneView): string {
  return JSON.stringify([
    pane.host_id,
    pane.pane,
    pane.updated_at,
    pane.activity,
    pane.attention.map(({ kind, message }) => [kind, message]),
    pane.freshness,
    pane.workstream,
  ]);
}

export function glanceNeedsRefresh(previous: string | null, next: string | null): boolean {
  return next !== null && next !== previous;
}

/**
 * A header age, verb-free so both the fetch and the refresh can borrow it.
 *
 * Unlike `age()`, this speaks in seconds — the header ticks every second and
 * must visibly advance. `age()` stays blank under a minute on purpose for
 * status-column noise; that made the strip read "fetched now ago" and freeze.
 */
function elapsedText(ms: number): string {
  // Clamped: a clock that stepped backwards (suspend, NTP) must read as now
  // rather than print a negative age.
  const elapsed = Math.max(0, ms);
  if (elapsed < 1_000) return "just now";
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}s ago`;
  return `${age(elapsed)} ago`;
}

/** How long ago the oldest peer fetch was. */
export function formatFetchedAge(ms: number): string {
  return `stalest fetch ${elapsedText(ms)}`;
}

/**
 * The header's one ticking field: how current the data on screen is.
 *
 * `refreshedAt` is when the dash's own collect cycle last completed, and it is
 * what the peerless case reports. `local` alone was a constant, so on a machine
 * with no peers the field never moved -- and a header field that cannot change
 * cannot answer the question it exists for, which is "is this thing still
 * running or has it wedged?". Every other cue on the dash is a fact about an
 * agent; this is the only one about murmur itself.
 *
 * Appended rather than substituted, because `local` is still worth saying: it
 * tells the reader the rows are this machine's and no ssh is involved, which is
 * why an unconfigured peer list shows nothing rather than being broken.
 *
 * Null when no refresh has completed yet -- the first tick fires before the
 * first collect resolves, and stating an age we do not have would be worse than
 * saying nothing for one second.
 */
export function fetchedText(
  view: Pick<Status, "peers">,
  now: number,
  refreshedAt: number | null = null,
): string {
  if (view.peers.length === 0)
    return refreshedAt === null ? "local" : `local · refreshed ${elapsedText(now - refreshedAt)}`;
  const neverFetched = view.peers.filter((peer) => peer.fetched_at === null).length;
  if (neverFetched > 0) return `${neverFetched} peer${neverFetched === 1 ? "" : "s"} never fetched`;
  const fetched = view.peers.flatMap((peer) => (peer.fetched_at === null ? [] : [peer.fetched_at]));
  const oldest = Math.min(...fetched);
  return formatFetchedAge(now - oldest);
}

/**
 * Selection index after a relative move. `wrap` is j/k; page/home use clamp.
 */
export function moveIndex(
  selected: number,
  offset: number,
  total: number,
  mode: "wrap" | "clamp" = "wrap",
): number {
  if (total <= 0) return 0;
  if (mode === "clamp") return Math.max(0, Math.min(total - 1, selected + offset));
  return (((selected + offset) % total) + total) % total;
}

/**
 * Follow-selection window into a card list, plus how many rows hide above/below.
 */
export function cardWindow(
  selectedIndex: number,
  total: number,
  visible: number,
): { first: number; shown: number; above: number; below: number } {
  const capacity = Math.max(1, visible);
  if (total <= 0) return { first: 0, shown: 0, above: 0, below: 0 };
  const shown = Math.min(capacity, total);
  const first = Math.max(0, Math.min(selectedIndex - Math.floor(shown / 2), total - shown));
  return {
    first,
    shown,
    above: first,
    below: Math.max(0, total - first - shown),
  };
}

/**
 * How many agents fit in the rail, which depends on what a row costs.
 *
 * A bordered card is three text rows inside a border: five. A compact row is
 * one line with no border at all, which is the entire point of the mode -- so
 * the window has to be computed from the row actually being painted, or the
 * dense view would scroll at the sparse view's pace and leave most of the rail
 * blank.
 *
 * The "N more" cues live inside the same fixed-height box as the rows, so when
 * the list overflows they have to be paid for first. Compact mode made that
 * systematic rather than occasional: at one line per row the window consumes
 * the rail exactly, so a cue pushed the box's children past its height at every
 * terminal size, and ink's default overflow is visible -- a fixed-height TUI
 * quietly turning into a scrollable one. Both cues are reserved whenever the
 * list does not fit, rather than resolving which of them shows: the window that
 * decides that is computed FROM this number, and one spare line beats a
 * circular definition.
 */
export function dashVisibleCards(railHeight: number, compact: boolean, total = 0): number {
  const rowCost = compact ? 1 : 5;
  const uncued = Math.max(1, Math.floor(railHeight / rowCost));
  if (total <= uncued) return uncued;
  return Math.max(1, Math.floor(Math.max(0, railHeight - 2) / rowCost));
}

/** Compact scroll cue for the header, or null when everything fits. */
export function scrollLabel(window: {
  first: number;
  shown: number;
  above: number;
  below: number;
  total: number;
}): string | null {
  if (window.total <= window.shown) return null;
  const from = window.first + 1;
  const to = window.first + window.shown;
  const up = window.above > 0 ? `↑${window.above} ` : "";
  const down = window.below > 0 ? ` ↓${window.below}` : "";
  return `${up}${from}\u2013${to}/${window.total}${down}`;
}

/**
 * The glance body's width in cells, derived the way ink actually lays the box
 * out rather than from the share directly.
 *
 * The rail and the glance are sized in PERCENTAGES, so yoga rounds the rail
 * first and the glance gets whatever columns are left. Computing the glance
 * side as `columns * share` instead disagrees with that by a column at most
 * widths -- and one column too many is not cosmetic: the clipped body then
 * exceeds the box, wraps, pushes the frame past the viewport, and ink erases
 * the wrong number of rows and leaves the previous frame's rows on screen.
 *
 * So the arithmetic mirrors the layout: round the RAIL, subtract, then take off
 * the border (1 each side) and paddingX (1 each side). A `bottom` glance spans
 * the full width and only pays the chrome.
 */
export function glanceBodyWidth(
  columns: number,
  share: number,
  placement: "right" | "bottom",
): number {
  const box =
    placement === "right"
      ? columns - Math.round((columns * Math.round((1 - share) * 100)) / 100)
      : columns;
  return Math.max(1, box - 4);
}

/**
 * How many glance body lines fit in a bordered box, reserving one row for the
 * scroll cue when the text is taller than the box.
 */
export function glanceViewport(
  lineCount: number,
  boxHeight: number,
): { visible: number; chrome: boolean } {
  const inner = Math.max(1, boxHeight - 2);
  if (lineCount <= inner) return { visible: inner, chrome: false };
  return { visible: Math.max(1, inner - 1), chrome: true };
}

export type DashFocus = "cards" | "preview";
export type DashNavKey = "up" | "down" | "pageUp" | "pageDown" | "home" | "end";
export type DashNavigation =
  | { type: "cards" | "preview"; offset: number }
  | { type: "cards-edge" | "preview-edge"; edge: "top" | "bottom" };

export function dashNavigation(
  focus: DashFocus,
  key: DashNavKey,
  cardPage: number,
  previewPage: number,
): DashNavigation {
  const type = focus === "cards" ? "cards" : "preview";
  if (key === "home" || key === "end") {
    return { type: `${type}-edge`, edge: key === "home" ? "top" : "bottom" };
  }
  const direction = key === "up" || key === "pageUp" ? -1 : 1;
  const page = focus === "cards" ? cardPage : previewPage;
  return { type, offset: direction * (key === "pageUp" || key === "pageDown" ? page : 1) };
}

/**
 * Focus plus the region input mode was opened from.
 *
 * `origin` is transient by design: it exists only while input mode is open, so
 * there is nothing to persist and nothing to migrate. Input always renders in
 * the preview, so entering it has to move focus there; remembering where focus
 * came from is the only way Escape can put it back.
 */
export type DashInputFocus = { focus: DashFocus; origin: DashFocus | null };
export type DashInputFocusEvent = "enter" | "leave";

export function dashInputFocus(state: DashInputFocus, event: DashInputFocusEvent): DashInputFocus {
  if (event === "enter") return { focus: "preview", origin: state.focus };
  return { focus: state.origin ?? state.focus, origin: null };
}

export type FooterHint = {
  chord: string;
  label: string;
  /** Current setting, for toggles whose state is otherwise invisible. */
  value?: string;
};

/** Which of the four mutually exclusive key regimes the dash is in. */
export type DashFooterMode = "normal" | "filter-active" | "filter-editing" | "input";

/**
 * The footer names only what this keypress can do, and nothing else.
 *
 * It used to carry the whole legend and shed entries by rank as the terminal
 * narrowed, which made the same chord appear or vanish with the pane width --
 * the one thing a reference line must not do. Four short fixed lines fit any
 * pane wide enough to run a dash, so there is no width budget left to spend and
 * no fitting pass to get wrong. Everything the footer stopped saying lives in
 * `?` (`dashHelpSections`), which is a panel and can afford to be complete.
 */
export function dashFooterHints(mode: DashFooterMode): FooterHint[] {
  if (mode === "input")
    return [
      { chord: "enter", label: "send" },
      { chord: "^e", label: "stop" },
      { chord: "esc", label: "leave" },
    ];
  if (mode === "filter-editing")
    return [
      { chord: "enter", label: "keep" },
      { chord: "esc", label: "clear" },
    ];
  if (mode === "filter-active")
    return [
      { chord: "esc", label: "clear" },
      { chord: "/", label: "edit" },
      { chord: "?", label: "shortcuts" },
    ];
  return [
    { chord: "/", label: "filter" },
    { chord: "?", label: "shortcuts" },
  ];
}

export type DashHelpSection = { title: string; hints: FooterHint[] };

/** What the view toggles are currently set to, for the help panel to report. */
export type DashViewState = {
  sort: DashSort;
  crew: boolean;
  hideStale: boolean;
  compact: boolean;
};

/**
 * The full legend, grouped, for the `?` panel.
 *
 * This is now the only complete list of the dash's bindings, so a chord added
 * to `useInput` and not added here is undiscoverable. The category test in
 * `test/dash-tick.test.ts` is what keeps the two in step.
 *
 * The view keys also carry their current setting. The old footer reported it
 * ("a crew on", "f stale on") and the contextual footer cannot afford to; with
 * the state named nowhere, a dash left with crew-only on reads as a dash that
 * lost its agents. The footer stays two chords wide -- this panel is the
 * surface with room to spare.
 */
export function dashHelpSections(view: DashViewState): DashHelpSection[] {
  return [
    {
      title: "navigation",
      hints: [
        { chord: "j/k", label: "select or scroll" },
        { chord: "^u/^d", label: "page" },
        { chord: "g/G", label: "top or end" },
        { chord: "tab", label: "switch cards and preview" },
      ],
    },
    {
      title: "actions",
      hints: [
        { chord: "enter", label: "jump to the agent" },
        { chord: "i", label: "prompt the agent" },
        { chord: "^r", label: "refresh now" },
        { chord: "q", label: "quit" },
      ],
    },
    {
      title: "filter",
      hints: [
        { chord: "/", label: "filter cards" },
        { chord: "esc", label: "clear the filter" },
      ],
    },
    {
      title: "view",
      hints: [
        { chord: "s", label: "cycle sort", value: view.sort },
        { chord: "a", label: "toggle crew only", value: view.crew ? "crew only" : "all" },
        { chord: "f", label: "toggle stale agents", value: view.hideStale ? "hidden" : "shown" },
        { chord: "c", label: "toggle compact rows", value: view.compact ? "on" : "off" },
        { chord: "+/-", label: "resize the preview" },
      ],
    },
    {
      title: "prompt",
      hints: [
        { chord: "^e", label: "send Escape to the agent" },
        { chord: "?", label: "open or close this help" },
      ],
    },
  ];
}

/**
 * The compact row's two-cell gutter: selection and focus, structurally.
 *
 * A borderless line had nothing but a background colour to carry both, and the
 * focused and unfocused selections were two light purples a hue apart --
 * invisible on a low-contrast or colour-blind terminal, where the bordered card
 * still had its double/single border to fall back on. Unselected rows pay the
 * same two cells so the columns stay aligned.
 */
export function compactSelectionMarker(selected: boolean, cardsFocused: boolean): string {
  if (!selected) return "  ";
  return cardsFocused ? "\u25b8 " : "\u00b7 ";
}

export type CompactRowFields = {
  state: string;
  agent: string;
  host: string;
  stream: string;
  flags: string;
  age: string;
  summary: string;
};

type CompactOptionalColumn = "host" | "stream" | "flags" | "age";

export type CompactRowLayout = {
  width: number;
  widths: Record<"state" | "agent" | CompactOptionalColumn, number>;
  columns: CompactOptionalColumn[];
  summary: boolean;
};

const COMPACT_CAPS = { agent: 24, host: 18, stream: 18 } as const;
const COMPACT_SUMMARY_MIN = 8;
const COMPACT_SEPARATOR = "  ";

function compactCell(value: string, width: number): string {
  const visible = visibleWidth(value);
  if (visible <= width) return value + " ".repeat(width - visible);
  // `clipToWidth` deliberately ignores a width of zero -- a blank glance is
  // worse than an overflowing one -- but a zero-width COLUMN means the layout
  // dropped it, so here the cell really does collapse.
  if (width <= 0) return "";
  if (width === 1) return clipToWidth(value, 1);
  return `${clipToWidth(value, width - 1)}…`;
}

/** Derive stable compact-table columns from every filtered row. */
export function compactRowLayout(
  rows: readonly CompactRowFields[],
  width: number,
): CompactRowLayout {
  const measured = (key: keyof CompactRowFields, cap = Number.POSITIVE_INFINITY) =>
    Math.min(cap, Math.max(0, ...rows.map((row) => visibleWidth(row[key]))));
  const widths = {
    state: Math.max(1, measured("state")),
    agent: Math.max(1, measured("agent", COMPACT_CAPS.agent)),
    host: measured("host", COMPACT_CAPS.host),
    stream: measured("stream", COMPACT_CAPS.stream),
    flags: measured("flags"),
    age: measured("age"),
  };
  const optionalColumns: CompactOptionalColumn[] = ["host", "stream", "flags", "age"];
  const columns = optionalColumns.filter((column) => widths[column] > 0);
  const used = () =>
    2 +
    widths.state +
    widths.agent +
    columns.reduce((sum, column) => sum + widths[column], 0) +
    COMPACT_SEPARATOR.length * (1 + columns.length);
  let summary = rows.some((row) => row.summary.length > 0);
  if (summary && width - used() < COMPACT_SEPARATOR.length + COMPACT_SUMMARY_MIN) summary = false;
  for (const column of ["flags", "age", "stream", "host"] as const) {
    if (used() <= width) break;
    const index = columns.indexOf(column);
    if (index >= 0) columns.splice(index, 1);
  }
  widths.agent = Math.max(1, Math.min(widths.agent, width - (used() - widths.agent)));
  return { width, widths, columns, summary };
}

/** Format one compact row; Ink only has to apply its selection styling. */
export function compactRow(
  row: CompactRowFields,
  layout: CompactRowLayout,
  marker: string,
): string {
  const cells = [
    compactCell(row.state, layout.widths.state),
    compactCell(row.agent, layout.widths.agent),
    ...layout.columns.map((column) => compactCell(row[column], layout.widths[column])),
  ];
  let line = `${marker}${cells.join(COMPACT_SEPARATOR)}`;
  if (layout.summary) {
    const remaining = layout.width - visibleWidth(line) - COMPACT_SEPARATOR.length;
    line += `${COMPACT_SEPARATOR}${compactCell(row.summary, Math.max(0, remaining))}`;
  }
  return compactCell(line, layout.width);
}

export type DashKeyRoute = "help-open" | "help-close" | "help-inert" | "dash";

/**
 * Where a keypress goes once help can be open — the modal precedence, pure.
 *
 * Help must be genuinely modal, not merely drawn on top: a reader who opened
 * `?` to look up the quit key must not lose the dash to the next `q`. So every
 * key that is not a close is swallowed (`help-inert`) rather than falling
 * through, and `?` toggles rather than re-opening.
 */
export function routeDashKey(
  helpOpen: boolean,
  input: string,
  key: { escape?: boolean; return?: boolean },
): DashKeyRoute {
  if (!helpOpen) return input === "?" ? "help-open" : "dash";
  return input === "?" || key.escape ? "help-close" : "help-inert";
}

/**
 * Clip one glance line to the visible width, before ink ever measures it.
 *
 * ink memoises text measurement in a module-level `Map` keyed by the string
 * itself, with no eviction (`ink/build/measure-text.js`). Every distinct string
 * the renderer has seen is retained for the life of the process -- measured at
 * ~0.24KB per line and surviving a forced GC.
 *
 * The dash is close to a worst case for that: the glance holds up to 2000 lines
 * of live `capture-pane` output and re-renders every second, so a working agent
 * produces new distinct text indefinitely. Left alone it reached 2.3GB RSS in
 * five and a half hours, growing ~240MB/hour.
 *
 * `wrap="truncate-end"` does not help, because it happens at PAINT time: ink
 * measures the whole 400-character line first and caches that. Clipping here
 * bounds the cache in the only way that works -- by collapsing the VARIETY, so
 * two lines differing only past the right-hand edge become one key rather than
 * two.
 *
 * Returns the input unchanged when it already fits, so text ink has measured
 * before does not become a second key. A width of zero or less is ignored
 * rather than honoured: a narrow terminal must still show something, and a
 * blank glance would be a worse bug than the one this fixes.
 *
 * Measured and cut in VISIBLE columns (see `clipToWidth`): since
 * `capture-pane -e`, a glance line carries SGR, and a byte-index clip both
 * shortened coloured lines far below the edge and could cut inside a sequence.
 */
export function clipGlanceLine(line: string, width: number): string {
  return clipToWidth(line, width);
}
