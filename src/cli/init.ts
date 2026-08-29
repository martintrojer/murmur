import type { Command } from "commander";
import { ensureIdentity } from "../identity.js";

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Initialize this node's identity")
    .option("--name <name>", "display name")
    .action((opts: { name?: string }) => {
      const identity = ensureIdentity(opts.name);
      console.log(`host_id: ${identity.host_id}`);
      console.log(`display_name: ${identity.display_name}`);
    });
}
