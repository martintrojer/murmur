/**
 * A standalone process that loads the REAL built extension and fires one event.
 *
 * Prints `RAN <pid>` and nothing else: whether the claim was accepted or refused
 * is a fact about the store, not something this process can see.
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

await handlers.get(state === "working" ? "agent_start" : "agent_end")?.();
// The handlers are `void enqueue(...)`, so they return before the write runs.
// Wait for the queue to drain rather than guessing with a timer.
await new Promise((resolve) => setTimeout(resolve, 600));

// Always RAN, never a verdict. This process cannot honestly say whether it won
// the pane: `owner_pid` is local-only and deliberately absent from every read
// shape, so there is nothing here to compare against its own pid. The test
// asserts what the STORE holds instead, which is the fact that matters and the
// one a lying child could not fake.
process.stdout.write(`RAN ${process.pid}\n`);

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
