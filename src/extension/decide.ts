import type { Driver } from "../types.js";

/**
 * THE THREE-EVENT DECISION TABLE. Read this before touching either function.
 *
 * pi fires three events murmur turns into state, and it fires them in a fixed
 * order that was verified at runtime against the shipped pi (0.84.3), not read
 * off the .d.ts:
 *
 *   agent_start    a run begins
 *   agent_end      that run's loop ended
 *   agent_settled  no retry, compaction or queued continuation will follow
 *
 * agent_end is NOT per turn -- `turn_start`/`turn_end` are. A three-tool-call
 * prompt fires one agent_start, three turn_end, one agent_end, one settled.
 * But agent_end CAN fire more than once per settle, because pi re-enters the
 * loop for a retry, a compaction, or a message queued by an agent_end handler,
 * and each re-entry emits its own agent_start first. Observed:
 *
 *   start, end, start, end, settled          (a queued continuation)
 *
 * So agent_start/agent_end always pair, and settled arrives exactly once, last,
 * ~60ms after the final agent_end.
 *
 * Both handlers append, and the fold takes the newest row it recognises, so the
 * LAST WRITER WINS. The extension's own promise queue serialises the handlers,
 * which is what makes "last" deterministic rather than a race. The table:
 *
 *   pane      driver         agent_start  agent_end  agent_settled  folds to
 *   --------  -------------  -----------  ---------  -------------  --------
 *   focused   human          working      cleared    (nothing)      idle
 *   unfocused human          working      done       blocked        blocked
 *   focused   orchestrated   working      cleared    (nothing)      idle
 *   unfocused orchestrated   working      cleared    (nothing)      idle
 *
 * Why each "nothing":
 *
 * FOCUSED. There is nothing to request -- the user is already looking at the
 * pane. agent_end has already written `cleared`, and re-asserting attention at
 * a human who is watching is the badge-that-outlives-its-cause bug.
 *
 * ORCHESTRATED. A crew agent settling is not a human's problem: mu placed the
 * work and mu consumes the result, which is why endState collapses it to
 * `cleared`. Emitting blocked here would put every finishing worker into the
 * status bar, which counts orchestrated `blocked` deliberately (status.ts) and
 * un-hides those rows in the picker. Orchestrated blocked stays reserved for an
 * outside notifier -- mu's own needs_input, or the `notify` verb.
 *
 * Why settled cannot clobber `working`, the cbcd9c4 failure mode: settled only
 * fires after a run ends, and a new run's agent_start is enqueued after it, so
 * `working` is always the later write. The queue, not luck, guarantees that.
 */

export function endState(focused: boolean, muManaged: boolean): "cleared" | "done" {
  if (muManaged) return "cleared";
  return focused ? "cleared" : "done";
}

/**
 * What `agent_settled` reports, or null for "say nothing".
 *
 * Unfocused plus settled is the one thing murmur exists to deliver: the agent
 * is genuinely finished and waiting on a human, and the human is not looking.
 * That is `blocked` -- the state that has been in the enum, the CLEARABLE
 * whitelist, the status counts and the picker filters since the beginning while
 * nothing in production ever produced it.
 *
 * Null rather than "cleared" for the two silent rows. agent_end has already
 * written the right thing for both, and a second append would only add a
 * redundant row whose timestamp becomes the agent's "last said something" age.
 */
export function settledState(focused: boolean, muManaged: boolean): "blocked" | null {
  if (muManaged) return null;
  return focused ? null : "blocked";
}

export function driverFromEnv(env: NodeJS.ProcessEnv): Driver {
  return env.MU_MANAGED_AGENT === "1" || env.MU_AGENT_NAME ? "orchestrated" : "human";
}
