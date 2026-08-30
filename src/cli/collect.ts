import type { Command } from "commander";
import { ssh } from "../channel.js";
import { collect, describeFailure } from "../collector.js";
import { openStore } from "../store.js";

export function registerCollect(program: Command): void {
  program
    .command("collect")
    .description("Collect events from configured peers")
    .option("-q, --quiet", "report nothing, not even unreachable peers")
    .action(async (options: { quiet?: boolean }) => {
      const store = openStore();
      try {
        const results = await collect(store, ssh);
        if (options.quiet) return;

        // The ONLY place a peer failure is printed. `collect` is run by a human
        // or a timer that wants the answer, unlike `status` (every status-bar
        // tick) and `pick` (inside a display-popup), both of which used to print
        // the same thing and could not stop.
        //
        // One line per peer, on stderr so a caller can still parse stdout, and
        // never a stack or an ssh command line.
        for (const result of results) {
          if (result.ok || !result.error) continue;
          process.stderr.write(`murmur: ${describeFailure(result.peer, result.error)}\n`);
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
