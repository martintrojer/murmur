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
 * How long ago the oldest peer fetch was, for the dash header.
 *
 * Unlike `age()`, this speaks in seconds — the header ticks every second and
 * must visibly advance. `age()` stays blank under a minute on purpose for
 * status-column noise; that made the strip read "fetched now ago" and freeze.
 */
export function formatFetchedAge(ms: number): string {
  const elapsed = Math.max(0, ms);
  if (elapsed < 1_000) return "fetched just now";
  if (elapsed < 60_000) return `fetched ${Math.floor(elapsed / 1000)}s ago`;
  return `fetched ${age(elapsed)} ago`;
}

export function fetchedText(view: Pick<Status, "peers">, now: number): string {
  if (view.peers.length === 0) return "local";
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

export type FooterHint = {
  chord: string;
  /** Empty when the compact form drops the verb. */
  label: string;
  value?: string;
  /** Higher drops first when the line will not fit. */
  drop: number;
};

const DOT = " · ";

export function hintWidth(hint: FooterHint): number {
  return (
    hint.chord.length +
    (hint.label ? 1 + hint.label.length : 0) +
    (hint.value !== undefined ? 1 + hint.value.length : 0)
  );
}

export function hintsWidth(hints: FooterHint[]): number {
  if (hints.length === 0) return 0;
  return hints.reduce((sum, hint) => sum + hintWidth(hint), 0) + DOT.length * (hints.length - 1);
}

/**
 * One-line footer budget: drop lowest-priority hints, then strip verbs, until
 * the line fits. Never wraps — a wrapped footer pushed the fixed-height TUI
 * into a scrollable viewport on narrow panes.
 */
export function fitFooterHints(hints: FooterHint[], columns: number): FooterHint[] {
  const budget = Math.max(0, columns);
  let fitted = hints.map((hint) => ({ ...hint }));

  while (fitted.length > 1 && hintsWidth(fitted) > budget) {
    let dropAt = 0;
    for (let index = 1; index < fitted.length; index += 1) {
      if ((fitted[index]?.drop ?? 0) >= (fitted[dropAt]?.drop ?? 0)) dropAt = index;
    }
    fitted = fitted.filter((_, index) => index !== dropAt);
  }

  if (hintsWidth(fitted) <= budget) return fitted;

  fitted = fitted.map((hint) => ({ ...hint, label: "" }));
  while (fitted.length > 1 && hintsWidth(fitted) > budget) {
    let dropAt = 0;
    for (let index = 1; index < fitted.length; index += 1) {
      if ((fitted[index]?.drop ?? 0) >= (fitted[dropAt]?.drop ?? 0)) dropAt = index;
    }
    fitted = fitted.filter((_, index) => index !== dropAt);
  }

  return fitted;
}

export function dashFooterHints(prefs: {
  sort: string;
  hide_stale: boolean;
  crew: boolean;
}): FooterHint[] {
  return [
    { chord: "j/k", label: "select", drop: 0 },
    { chord: "enter", label: "jump", drop: 1 },
    { chord: "s", label: "sort", value: prefs.sort, drop: 2 },
    { chord: "q", label: "quit", drop: 3 },
    { chord: "a", label: "crew", value: prefs.crew ? "on" : "off", drop: 4 },
    { chord: "f", label: "stale", value: prefs.hide_stale ? "off" : "on", drop: 5 },
    { chord: "^r", label: "refresh", drop: 6 },
    { chord: "^u/^d", label: "page", drop: 7 },
    { chord: "g/G", label: "top/end", drop: 8 },
    { chord: "+/-", label: "preview", drop: 9 },
  ];
}
