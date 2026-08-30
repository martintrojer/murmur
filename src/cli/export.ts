import type { Command } from "commander";
import { tmux } from "../mux.js";
import { openStore } from "../store.js";
import { requireIdentity } from "./identity-guard.js";

export function registerExport(program: Command): void {
  program
    .command("export")
    // No options, and none to add: the document is complete, so a peer that
    // returns one has said everything it knows and absence in it is absence.
    // There is nothing narrower for a caller to ask for.
    .description("Print this node's current-state snapshot")
    .action(() => {
      const identity = requireIdentity();
      if (!identity) return;
      const store = openStore();
      try {
        // `buildLocalSnapshot` reconciles first, which is what makes the
        // document authoritative: a snapshot built from unreconciled rows would
        // publish agents whose panes are gone, and a reader has no way to tell.
        const snapshot = store.buildLocalSnapshot(identity, { panes: tmux.livePanes() });
        process.stdout.write(`${JSON.stringify(snapshot)}\n`);
      } finally {
        store.close();
      }
    });
}
