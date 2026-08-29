import type { Command } from "commander";
import { exportJsonl } from "../export.js";
import { pidAlive, tmux } from "../mux.js";
import { openStore } from "../store.js";

export function registerExport(program: Command): void {
  program
    .command("export")
    .description("Export local events as JSONL")
    .requiredOption("--since <seq>", "export events after this sequence", Number)
    .action((options: { since: number }) => {
      const store = openStore();
      try {
        process.stdout.write(exportJsonl(store, options.since, pidAlive, tmux.liveWindows()));
      } finally {
        store.close();
      }
    });
}
