import type { Command } from "commander";
import { ssh } from "../channel.js";
import {
  attachmentHoldingPeer,
  COLLECT_FLOOR_MS,
  collect,
  describeFailure,
  sessionChannelBusy,
} from "../collector.js";
import { tmux } from "../mux.js";
import { openStore } from "../store.js";
import { requireIdentity } from "./identity-guard.js";

export function registerCollect(program: Command): void {
  program
    .command("collect")
    .description("Fetch each peer's snapshot")
    .option("-q, --quiet", "report nothing, not even unreachable peers")
    // For the picker's background refresh, which runs unattended on every
    // launch: without a floor, flicking the picker open repeatedly fans out ssh
    // per keystroke. A human typing `murmur collect` wants the fetch NOW, so the
    // floor is opt-in and this flag is undocumented in the help text below.
    .option("--floored", "skip peers attempted recently (internal)", false)
    .action(async (options: { quiet?: boolean; floored?: boolean }) => {
      if (!requireIdentity()) return;
      const store = openStore();
      try {
        const results = await collect(store, ssh, Date.now(), {
          floorMs: options.floored ? COLLECT_FLOOR_MS : 0,
        });
        if (options.quiet) return;

        // The ONLY place a peer failure is printed. `collect` is run by a human
        // or a timer that wants the answer, unlike `status` (every status-bar
        // tick) and `pick` (inside a display-popup), both of which used to print
        // the same thing and could not stop.
        //
        // One line per peer, on stderr so a caller can still parse stdout, and
        // never a stack or an ssh command line.
        // Read the local panes ONCE, and only when something actually failed with
        // a session-channel refusal: this is a `ps` per pane, far too costly to
        // pay on a healthy collect.
        const busy = results.some(
          (result) => !result.ok && result.error && sessionChannelBusy(result.error),
        );
        const localPanes = busy ? tmux.localPaneProcesses() : [];
        const peersByName = new Map(store.peers().map((peer) => [peer.name, peer]));
        for (const result of results) {
          if (result.ok || !result.error) continue;
          const jump = peersByName.get(result.peer)?.jump_command;
          const culprit = jump && busy ? attachmentHoldingPeer(jump, localPanes) : null;
          process.stderr.write(`murmur: ${describeFailure(result.peer, result.error, culprit)}\n`);
        }

        // A summary only when something is wrong, and only for the case a human
        // can act on. An unreachable node is the normal state of a fleet -- a
        // laptop asleep, a box switched off -- so it is reported per peer above
        // and not counted as a failure here.
        if (results.some((result) => !result.ok && !result.unreachable)) {
          process.exitCode = 1;
        }
      } finally {
        store.close();
      }
    });
}
