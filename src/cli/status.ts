import type { Command } from "commander";
import { statusWithCollect, tmuxStatus } from "../status.js";
import { openStore } from "../store.js";

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show folded agent status")
    .option("--json", "print JSON")
    .action(async (options: { json?: boolean }) => {
      const store = openStore();
      try {
        const view = await statusWithCollect(store);
        process.stdout.write(
          options.json ? `${JSON.stringify(view, null, 2)}\n` : tmuxStatus(view),
        );
      } finally {
        store.close();
      }
    });
}
