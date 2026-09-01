import type { Driver } from "../types.js";

/**
 * pi's three events, in the order verified at runtime against pi 0.84.3 (not
 * read off the .d.ts):
 *
 *   agent_start    a run begins          -> activity: running
 *   agent_end      that run's loop ended -> activity: stopped
 *   agent_settled  nothing will follow   -> may raise attention
 *
 * start/end always pair and can repeat within one settle, because pi re-enters
 * the loop for a retry, a compaction, or a queued message (observed: start,
 * end, start, end, settled). settled arrives once, last. Per-turn events are
 * `turn_start`/`turn_end`, not these.
 *
 * Activity and attention are independent: start/end only write activity,
 * settled only raises attention, and nothing reconciles the two.
 *
 * Only an unfocused human pane gets attention on settle. A focused pane has
 * nothing to request -- the user is looking at it. An orchestrated one is mu's
 * to consume, and raising attention there would put every finishing worker in
 * the status bar and unhide its picker row.
 */

/**
 * Whether `agent_settled` raises attention. Null means say nothing.
 *
 * `"done"` is the whole range: an owner can report that it finished, and only
 * an external notifier can report `blocked`.
 */
export function settledState(focused: boolean, muManaged: boolean): "done" | null {
  if (muManaged) return null;
  return focused ? null : "done";
}

export function driverFromEnv(env: NodeJS.ProcessEnv): Driver {
  return env.MU_MANAGED_AGENT === "1" || env.MU_AGENT_NAME ? "orchestrated" : "human";
}
