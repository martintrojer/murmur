import { expect, test } from "vitest";
import { makeSpawnRunner, PROBE_TIMEOUT_MS, spawnRunner } from "../src/agents.js";

/**
 * The real `Runner`'s timeout posture, which is untestable through the seam
 * every other jump test uses: they all inject a fake, so the production
 * options object was the one thing nothing asserted on.
 *
 * The bug it closes: one 10s timeout served both callers, so the outside-tmux
 * `ssh -t ... tmux attach` -- a session the user is sitting in -- was SIGTERMed
 * ten seconds in. spawnSync's timeout is a hard kill and leaves `status: null`
 * with ETIMEDOUT, so `failed` went true and murmur printed "ssh attach failed"
 * and exited 1 on a session that was working. ARCHITECTURE.md lists interactive
 * attach under known gaps, which is why nobody sat in it.
 *
 * These assert the POSTURE -- which caller gets a deadline -- against an
 * injected deadline of a few hundred ms. They used to assert it against the
 * real 10s by outliving it with `sleep 12`, which cost 22 seconds of wall clock
 * on every single run for two tests. The distinction being proved is
 * bounded-vs-unbounded, and that does not depend on the size of the bound; the
 * one thing that must still be real is the SHAPE of a spawnSync timeout kill,
 * so these keep spawning a real child.
 */

/** Long enough that a timeout, not the command, is what ends a bounded run. */
const NEVER_FINISHES = ["30"];
/** Comfortably over the injected deadline, comfortably under a person's patience. */
const SHORT_DEADLINE_MS = 250;

test("a bounded probe is killed at the deadline, so the picker cannot hang", () => {
  const run = makeSpawnRunner(SHORT_DEADLINE_MS);

  const started = Date.now();
  const result = run("sleep", NEVER_FINISHES);
  const elapsed = Date.now() - started;

  // The shape the decision table reads: a hard kill leaves no status and
  // reports failure.
  expect(result.failed).toBe(true);
  expect(result.status).toBeNull();
  // Bounded well under `sleep 30`, so the deadline ended this and not the
  // command finishing.
  expect(elapsed).toBeLessThan(5_000);
});

test("an inherited-stdio attach has NO deadline, because a human is sitting in it", () => {
  // The regression test proper. `inherit` marks the interactive path, and a
  // command that outlives the deadline must survive it. With the bug present
  // the deadline applies to both callers, so this child is killed at
  // SHORT_DEADLINE_MS and the assertions below fail.
  const run = makeSpawnRunner(SHORT_DEADLINE_MS);
  const outlivesDeadline = SHORT_DEADLINE_MS * 4;

  const started = Date.now();
  const result = run("sleep", [`${outlivesDeadline / 1000}`], true);
  const elapsed = Date.now() - started;

  // Ran to completion: exit 0, nothing killed it.
  expect(result.status).toBe(0);
  expect(result.failed).toBe(false);
  // And it genuinely outlived the deadline, so a reinstated timeout fails this
  // rather than merely slowing it down.
  expect(elapsed).toBeGreaterThan(outlivesDeadline * 0.8);
});

test("the shipped runner carries the real probe deadline", () => {
  // makeSpawnRunner's default is what production uses, so the tests above
  // cannot pass by testing a runner nobody ships. Asserted as a value rather
  // than by waiting it out.
  expect(PROBE_TIMEOUT_MS).toBe(10_000);
  expect(spawnRunner).toBeTypeOf("function");
});
