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

/**
 * React's DEVELOPMENT reconciler leaks the dash's heap, unboundedly.
 *
 * Lives in this file because it shares the deferred-import reasoning above: the
 * dash's react is pulled in by the dynamic import in the action, and this has
 * to be set before that happens.
 *
 * `react-reconciler/index.js` picks its build from `NODE_ENV` at require time,
 * and a CLI is normally launched with it unset -- so the dash loaded the dev
 * build, which instruments every render with `performance.measure()`. Node's
 * performance timeline has no default buffer limit for user timing, so each
 * entry is retained for the life of the process, and the dash re-renders on a
 * timer forever.
 *
 * Measured on the real dash: ~1,400 retained entries per minute and post-GC
 * heap climbing ~87MB/hour with no plateau, which reaches the 4GB default heap
 * cap in around two days -- matching the observed OOM at 38.5 hours uptime.
 * With this set: zero entries and flat retention over the same run.
 *
 * This is a separate leak from the one bounded in `3b61870`. That one was
 * native yoga churn -- RSS climbing while the JS heap stayed flat -- and was
 * addressed by rendering less often and measuring fewer strings. This one is
 * pure JS retention and no amount of rendering less would have fixed it; it
 * only made the dash take longer to die.
 *
 * Set here rather than in `runDash` because it must land BEFORE the dynamic
 * import below pulls in react: the build choice is made once, at require time,
 * and is not revisited.
 *
 * Only defaulted, never overridden, so `NODE_ENV=development murmur dash` still
 * gets the dev build's warnings when that is what someone wants.
 */
function preferProductionReact(env: NodeJS.ProcessEnv = process.env): void {
  env.NODE_ENV ??= "production";
}

export function registerDash(program: Command): void {
  program
    .command("dash")
    .description("Watch agents and glance at their panes")
    .option("--goto", "switch to the running dash, or leave a murmur-controlled remote session")
    .action(async (options: { goto?: boolean }) => {
      preferProductionReact();
      const { runDash } = await import("./dash.js");
      await runDash(options);
    });
}
