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
  return `fetched ${elapsedText(ms)}`;
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
  if (view.peers.some((peer) => peer.fetched_at === null)) return "fetched never";
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
 */
export function dashVisibleCards(railHeight: number, compact: boolean): number {
  return Math.max(1, Math.floor(railHeight / (compact ? 1 : 5)));
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

export type FooterHint = {
  chord: string;
  label: string;
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

/**
 * The full legend, grouped, for the `?` panel.
 *
 * This is now the only complete list of the dash's bindings, so a chord added
 * to `useInput` and not added here is undiscoverable. The category test in
 * `test/dash-tick.test.ts` is what keeps the two in step.
 */
export function dashHelpSections(): DashHelpSection[] {
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
        { chord: "s", label: "cycle sort" },
        { chord: "a", label: "toggle crew only" },
        { chord: "f", label: "toggle stale agents" },
        { chord: "c", label: "toggle compact rows" },
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
 */
export function clipGlanceLine(line: string, width: number): string {
  if (width <= 0 || line.length <= width) return line;
  return line.slice(0, width);
}
