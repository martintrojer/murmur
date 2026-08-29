import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";

export function registerLink(program: Command): void {
  program
    .command("link")
    .description("Install a murmur integration")
    .argument("<target>", "integration to install")
    .action((target: string) => {
      if (target !== "pi") throw new Error(`unsupported link target: ${target}`);
      const destination = join(
        process.env.MURMUR_PI_HOME ?? homedir(),
        ".pi",
        "agent",
        "extensions",
        "murmur.ts",
      );
      mkdirSync(dirname(destination), { recursive: true });

      // Pin the store import to this installation's absolute path. The
      // extension lives in ~/.pi/agent/extensions, where a bare
      // "@martintrojer/murmur/extension-store" specifier cannot resolve — not
      // even for a global install. Unpinned, every append silently no-ops:
      // the tmux badge still paints, so nothing looks broken while the log
      // stays empty and the node exports nothing.
      const source = readFileSync(
        fileURLToPath(new URL("./extension/murmur-pi.js", import.meta.url)),
        "utf8",
      );
      const storePath = fileURLToPath(new URL("./extension/store.js", import.meta.url));
      const pinned = source.replace(
        /"@martintrojer\/murmur\/extension-store"/,
        JSON.stringify(storePath),
      );
      if (pinned === source) {
        throw new Error("link pi: could not pin the store import; extension build changed");
      }
      writeFileSync(destination, pinned);
      console.log(destination);
    });
}
