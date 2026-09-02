import { expect, test } from "vitest";
import { spawnRunner } from "../src/agents.js";

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
 */

test("a bounded probe is killed at the deadline, so the picker cannot hang", () => {
  // Slightly over the 10s bound would make this test take ten seconds, so the
  // assertion is the reported SHAPE of a timeout kill rather than the duration:
  // status null plus `failed`, which is what the decision table reads.
  const started = Date.now();
  const result = spawnRunner("sleep", ["30"]);
  const elapsed = Date.now() - started;

  expect(result.failed).toBe(true);
  expect(result.status).toBeNull();
  // Bounded well under `sleep 30`, so it was the timeout that ended this and
  // not the command finishing.
  expect(elapsed).toBeLessThan(20_000);
}, 30_000);

test("an inherited-stdio attach has NO deadline, because a human is sitting in it", () => {
  // The regression test proper. `inherit` marks the interactive path, and a
  // command that outlives the old 10s bound must survive it.
  //
  // 12 seconds, deliberately over the 10s probe timeout: under it, this test
  // passes whether or not the fix is present. That is the whole point of the
  // number, so it is stated rather than tuned down for speed.
  const started = Date.now();
  const result = spawnRunner("sleep", ["12"], true);
  const elapsed = Date.now() - started;

  // Ran to completion: exit 0, nothing killed it.
  expect(result.status).toBe(0);
  expect(result.failed).toBe(false);
  // And it genuinely outlived the probe's deadline, so a reinstated timeout
  // fails this rather than merely slowing it down.
  expect(elapsed).toBeGreaterThan(11_000);
}, 30_000);
