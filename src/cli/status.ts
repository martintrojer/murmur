import type { Command } from "commander";
import { ssh } from "../channel.js";
import { COLLECT_FLOOR_MS } from "../collector.js";
import { statusWithCollect, tmuxStatus } from "../status.js";
import { openStore } from "../store.js";
import { requireIdentity } from "./identity-guard.js";

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show current agent status")
    .option("--json", "print JSON")
    .action(async (options: { json?: boolean }) => {
      const identity = requireIdentity();
      if (!identity) return;
      const store = openStore();
      try {
        // The one surface that passes a floor. tmux re-runs this on every
        // `status-interval` -- per attached client -- and a repaint is not a
        // reason to reach a machine.
        const view = await statusWithCollect(store, identity, Date.now(), ssh, {
          floorMs: COLLECT_FLOOR_MS,
        });
        process.stdout.write(
          options.json ? `${JSON.stringify(view, null, 2)}\n` : tmuxStatus(view),
        );
      } finally {
        store.close();
      }
    });
}
