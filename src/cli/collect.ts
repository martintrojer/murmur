import type { Command } from "commander";
import { ssh } from "../channel.js";
import { collect } from "../collector.js";
import { openStore } from "../store.js";

export function registerCollect(program: Command): void {
  program
    .command("collect")
    .description("Collect events from configured peers")
    .action(async () => {
      const store = openStore();
      try {
        await collect(store, ssh);
      } finally {
        store.close();
      }
    });
}
