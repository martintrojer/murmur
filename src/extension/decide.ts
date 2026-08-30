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
 * The two axes are independent. `agent_start` and `agent_end` write ACTIVITY
 * (running / stopped) and nothing else; `agent_settled` may raise ATTENTION and
 * never touches activity. Nothing resolves one against the other, so the table
 * is short:
 *
 *   pane      driver         agent_start  agent_end  agent_settled
 *   --------  -------------  -----------  ---------  -----------------
 *   focused   human          running      stopped    (nothing)
 *   unfocused human          running      stopped    attention: done
 *   focused   orchestrated   running      stopped    (nothing)
 *   unfocused orchestrated   running      stopped    (nothing)
 *
 * Why each "nothing":
 *
 * FOCUSED. There is nothing to request -- the user is already looking at the
 * pane. Re-asserting attention at a human who is watching is the
 * badge-that-outlives-its-cause bug.
 *
 * ORCHESTRATED. A crew agent settling is not a human's problem: mu placed the
 * work and mu consumes the result. Raising attention here would put every
 * finishing worker into the status bar and un-hide those rows in the picker.
 *
 * Completion is `done`. `blocked` is never authored by an owner -- it comes only
 * from an external notifier -- and that split is what makes attention and
 * activity genuinely independent rather than two spellings of one enum.
 */

/**
 * Whether `agent_settled` raises attention, and of which kind. Null means say
 * nothing.
 *
 * `"done" | null` is the whole range: an owner reports that it finished, and only
 * a notifier can report that someone is wanted.
 */
export function settledState(focused: boolean, muManaged: boolean): "done" | null {
  if (muManaged) return null;
  return focused ? null : "done";
}

export function driverFromEnv(env: NodeJS.ProcessEnv): Driver {
  return env.MU_MANAGED_AGENT === "1" || env.MU_AGENT_NAME ? "orchestrated" : "human";
}
