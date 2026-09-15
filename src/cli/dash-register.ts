import type { Command } from "commander";

/**
 * Register `murmur dash` WITHOUT loading the dash module.
 *
 * `dash.tsx` imports ink (and react through it) at top level. Node resolves
 * static imports eagerly, so `import { registerDash } from "./dash.js"` in
 * `cli.ts` pulled the whole TUI stack into EVERY invocation -- including
 * `murmur status`, which the tmux status bar runs on a loop.
 *
 * Measured: importing ink alone costs ~0.22s against ~0.03s for a bare node
 * start, and `murmur --version` (which does no work at all) took 0.23s. With
 * the dash module deferred, `murmur status` went 0.29s -> 0.11s and its
 * process count over five runs went 162 -> 65.
 *
 * The command's SURFACE is declared here rather than inside the dynamic
 * import: commander needs the name, description and options at parse time so
 * `murmur --help` and `murmur dash --help` keep working, and arg-parse errors
 * keep being reported, without paying for ink. Only the action body -- the
 * part that actually renders -- waits for the import.
 *
 * `.action()` was already async, so awaiting the import inside it changes no
 * call-site contract.
 */
export function registerDash(program: Command): void {
  program
    .command("dash")
    .description("Watch agents and glance at their panes")
    .option("--goto", "switch to the running dash, or leave a murmur-controlled remote session")
    .action(async (options: { goto?: boolean }) => {
      const { runDash } = await import("./dash.js");
      await runDash(options);
    });
}
