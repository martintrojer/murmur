import { execFileSync } from "node:child_process";
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

export function glance(store: Store, agent: PaneView, lines = GLANCE_LINES): string | null {
  if (agent.local) return tmux.capture(agent.pane, lines);

  const peer = store.peers().find((candidate) => candidate.host_id === agent.host_id);
  const target = peer?.target ?? peer?.name;
  if (!target) return null;
  try {
    // The pane id is `%N`, which a remote shell leaves alone, but quote it
    // anyway: the same class of bug as the `$N` session id that made remote
    // jump fail silently for a day.
    return execFileSync(
      "ssh",
      [
        ...SSH_OPTIONS,
        target,
        "tmux",
        "capture-pane",
        "-p",
        "-t",
        `'${agent.pane}'`,
        "-S",
        `-${lines}`,
      ],
      { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    // Unreachable, cold socket, dead tmux, gone pane. The preview says so
    // rather than the picker failing.
    return null;
  }
}
