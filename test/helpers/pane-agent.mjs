/**
 * A standalone process that loads the REAL built extension and fires one event.
 *
 * Exists so `pane-ownership.test.ts` can reproduce the six-pid bug with actual
 * operating-system processes in an actual tmux pane. The bug is entirely about
 * what a SEPARATE process inherits -- $TMUX_PANE, and the owner's claim -- so a
 * mocked child cannot reproduce it: the inheritance IS the mechanism.
 *
 * argv[2] is the state to report. It stays alive until killed so that the
 * "recorded pid is still alive" floor has something live to protect, which is
 * the condition the real bug violated.
 */
const [, , state = "working", holdMs = "0", spawnChild = ""] = process.argv;

// The extension path is passed IN rather than resolved here, so the staleness
// check in test/helpers/built.ts is what decides which artifact runs. Resolving
// `../../dist/...` locally would bypass it, and this file executes the built
// extension -- exactly the case where a stale build passes while testing code
// you did not write.
const entry = process.env.MURMUR_EXTENSION_ENTRY;
if (!entry) throw new Error("MURMUR_EXTENSION_ENTRY is required");
const { default: murmurPi } = await import(entry);

const handlers = new Map();
murmurPi({ on: (event, handler) => handlers.set(event, handler) });

// No handler registered at all means the extension declined to own this pane,
// which is the nested case. Report that distinctly from "ran and wrote nothing".
if (handlers.size === 0) {
  process.stdout.write("DECLINED\n");
  process.exit(0);
}

await handlers.get(state === "working" ? "agent_start" : "agent_end")?.();
// The handlers are `void enqueue(...)`, so they return before the append runs.
// Wait for the queue to drain rather than guessing with a timer.
await new Promise((resolve) => setTimeout(resolve, 600));

process.stdout.write(`REPORTED ${process.pid}\n`);

// Spawn a nested run the way a real agent would: a plain child process,
// inheriting this process's environment and nothing else. Nothing is passed to
// it explicitly, so the claim has to have been PUBLISHED for the child to know
// it is nested. Without this, a test can pass the claim in by hand and never
// exercise the publishing side at all -- which is exactly what a mutation that
// deleted the publish revealed.
if (spawnChild) {
  const { execFileSync } = await import("node:child_process");
  const childOut = execFileSync(process.execPath, [process.argv[1], state, "0"], {
    encoding: "utf8",
    timeout: 20_000,
  });
  process.stdout.write(`CHILD ${childOut.trim()}\n`);
}

if (Number(holdMs) > 0) await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
