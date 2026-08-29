import { execFileSync } from "node:child_process";
import type { Agent } from "./agents.js";
import { loadIdentity } from "./identity.js";
import { tmux } from "./mux.js";
import type { Store } from "./store.js";

/**
 * Glance: the last few lines a pane printed.
 *
 * This is the cheap half of the two things "render any pane from the master"
 * hides. It is a stateless `capture-pane`, not a frame stream — no resize
 * negotiation, no input routing, no reconnect. That deferral is what keeps
 * murmur a state layer instead of a multiplexer (DESIGN-NOTES, "Deferring
 * interactive remote rendering"), and it is why this file is thirty lines
 * rather than most of herdr.
 */

const GLANCE_LINES = 40;

// Same posture as the collector: reuse a warm control socket when there is one,
// cold-connect when there is not, and never prompt. BatchMode is what matters
// here — a preview pane redrawing on every keypress must never block on a
// human. Kept in sync with SSH_OPTIONS in channel.ts by hand.
const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ControlMaster=no",
  "-o",
  "ControlPath=~/.ssh/control/%r@%h:%p",
  "-o",
  "ConnectTimeout=2",
];

export function glance(store: Store, agent: Agent, lines = GLANCE_LINES): string | null {
  if (agent.host_id === loadIdentity()?.host_id) return tmux.capture(agent.pane, lines);

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
