import { execFileSync } from "node:child_process";
import { shellQuote } from "./agents.js";
import { SSH_OPTIONS } from "./channel.js";
import { tmux } from "./mux.js";
import type { Store } from "./store.js";
import type { PaneView } from "./view.js";

/**
 * Glance: the last few lines a pane printed.
 *
 * The cheap half of what "render any pane from the master" hides: a stateless
 * `capture-pane`, not a frame stream -- no resize negotiation, no input routing,
 * no reconnect. That deferral is what keeps murmur a state layer rather than a
 * multiplexer (see ARCHITECTURE.md's non-goals), and why this file is thirty
 * lines instead of most of herdr.
 */

const GLANCE_LINES = 40;

/**
 * The one ssh a glance runs, injectable for the same reason `agents.ts` has
 * `Runner`: without a seam the remote branch cannot be tested without a second
 * machine, and the skip below -- which is the whole point of this file's
 * bug history -- would have no coverage at all.
 */
export type GlanceRunner = (target: string, argv: string[]) => string;

const sshRunner: GlanceRunner = (target, argv) =>
  execFileSync("ssh", [...SSH_OPTIONS, target, ...argv], {
    encoding: "utf8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "ignore"],
  });

export function glance(
  store: Store,
  agent: PaneView,
  lines = GLANCE_LINES,
  run: GlanceRunner = sshRunner,
): string | null {
  if (agent.local) return tmux.capture(agent.pane, lines);

  const peer = store.peers().find((candidate) => candidate.host_id === agent.host_id);
  const target = peer?.target ?? peer?.name;
  if (!target) return null;
  // Never dial a peer whose last attempt failed.
  //
  // The preview runs PER KEYPRESS as the cursor moves, so this ssh is on the
  // interactive path in a way the collector's never is. A host that cannot
  // authenticate costs the full exchange to fail -- measured at ~1.5s against a
  // real peer rejecting keyboard-interactive, against 70ms for a local row --
  // and every pass over that row paid it again. That was "the picker is slow".
  //
  // `last_error` is the right question and costs nothing: the store clears it on
  // every successful fetch, so a non-null value means the MOST RECENT collect
  // failed. Not keyed on `freshness`, which is a clock: a peer can be stale
  // merely because the floor has not come round yet, and skipping it would
  // withhold a glance from a host that answers fine.
  //
  // The row itself still previews. Its metadata is cached and worth reading --
  // and a peer whose fetch failed keeps its last-known snapshot, which is
  // exactly why the row is on screen at all.
  if (peer?.last_error !== null) return null;
  try {
    // `shellQuote`, not `'${...}'`, because nothing constrains this value to
    // `%N`: it arrives in a peer's snapshot, `parseSnapshot` checks only that it
    // is a non-empty string, and `asPaneId` deliberately round-trips an id
    // murmur does not recognise. Hand-rolled quotes do not escape an embedded
    // single quote, so a pane containing one would close the quote and hand the
    // remainder to the remote login shell as code -- ssh joins its argv into one
    // string, so this is execution rather than a mangled argument.
    //
    // The trust boundary is a peer the operator configured, which is why this
    // was never urgent; the posture is safety by construction, and the tested
    // helper every other ssh path already uses was one import away.
    return run(target, [
      "tmux",
      "capture-pane",
      "-p",
      "-t",
      shellQuote(agent.pane),
      "-S",
      `-${lines}`,
    ]);
  } catch {
    // Cold socket, dead tmux, gone pane. The preview says so rather than the
    // picker failing.
    return null;
  }
}
