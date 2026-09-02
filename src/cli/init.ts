import type { Command } from "commander";
import { createIdentity, loadIdentity, type NodeIdentity, setDisplayName } from "../identity.js";

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
      let identity: NodeIdentity;
      try {
        identity = existing
          ? opts.name
            ? setDisplayName(opts.name)
            : existing
          : createIdentity(opts.name);
      } catch (error) {
        // An empty `--name` is operator error, not a murmur fault, and the
        // writer refuses it because a nameless node is broken from every peer's
        // point of view while looking fine locally. A stack trace for a
        // mistyped flag buries the one line that says what to do -- and there
        // is no global handler, so this is the place to catch it.
        process.stderr.write(`murmur: ${error instanceof Error ? error.message : error}\n`);
        process.exitCode = 1;
        return;
      }
      console.log(`host_id: ${identity.host_id}`);
      console.log(`display_name: ${identity.display_name}`);
    });
}
