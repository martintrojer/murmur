import type { Command } from "commander";
import { createIdentity, loadIdentity, setDisplayName } from "../identity.js";

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Initialize this node's identity")
    .option("--name <name>", "display name")
    .action((opts: { name?: string }) => {
      // `--name` on an already-initialised node RENAMES it, keeping the host_id.
      // It used to be ignored silently, which is the one thing a rename must not
      // do: the operator's only feedback was the old name printed back.
      const existing = loadIdentity();
      const identity = existing
        ? opts.name
          ? setDisplayName(opts.name)
          : existing
        : createIdentity(opts.name);
      console.log(`host_id: ${identity.host_id}`);
      console.log(`display_name: ${identity.display_name}`);
    });
}
