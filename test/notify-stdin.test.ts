import { spawn } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "vitest";

/**
 * `notify` must terminate when stdin is a pipe nobody ever closes.
 *
 * The realistic shape, and the one that bit: a long-lived plugin host spawns the
 * hook without redirecting stdin, so the child inherits a pipe the parent
 * created, never writes to, and never ends. Reading to EOF waits for an EOF that
 * never arrives, and the hook hangs holding a store handle.
 *
 * Asserts the PROCESS EXITS, not that the read resolves. An earlier attempt at
 * this fix bounded the read correctly and still hung, because `pause()` leaves
 * the stream handle on the event loop -- so a test that only checked the return
 * value passed against code that never terminated.
 *
 * Kills by pid on failure, so a regression fails this test rather than hanging
 * the suite.
 */
function runWithOpenPipe(args: string[], budgetMs: number): Promise<boolean> {
  const child = spawn(process.execPath, [join(process.cwd(), "dist", "cli.js"), ...args], {
    // "pipe" and then never written to, never ended: the inherited-pipe case.
    stdio: ["pipe", "ignore", "ignore"],
  });
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, budgetMs);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

test("notify exits when stdin is an inherited pipe that never closes", async () => {
  const exited = await runWithOpenPipe(["notify", "--source", "stdin-probe"], 4000);
  expect(exited, "notify hung on an open inherited pipe").toBe(true);
}, 10000);

test("a payload arriving in chunks is still read in full", async () => {
  const child = spawn(process.execPath, [join(process.cwd(), "dist", "cli.js"), "notify"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  // Split across two writes with a gap, so a read that stops at the first chunk
  // produces different JSON and a different recorded row.
  child.stdin.write('{"source":"chunked",');
  await new Promise((r) => setTimeout(r, 60));
  child.stdin.write('"title":"two writes"}');
  child.stdin.end();
  const code = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(-1);
    }, 4000);
    child.on("exit", (status) => {
      clearTimeout(timer);
      resolve(status ?? -1);
    });
  });
  expect(code).toBe(0);
}, 10000);
