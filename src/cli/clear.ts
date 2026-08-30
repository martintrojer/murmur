import type { Command } from "commander";
import { loadIdentity } from "../identity.js";
import { type Mux, tmux } from "../mux.js";
import { openStore, type Store } from "../store.js";
import type { Driver } from "../types.js";

type OwnedPane = {
  agent_id: string;
  session_name: string | null;
  window_name: string | null;
  agent_name: string | null;
  pi_session: string | null;
  session: string;
  window: string;
  pane: string;
  workstream: string | null;
  role: string | null;
  cli: string | null;
  driver: Driver | null;
  state: string;
};

/**
 * States that focus is allowed to clear.
 *
 * `clear` runs from tmux focus hooks, so the only fact it knows is "the user
 * looked at this pane". That satisfies an attention REQUEST -- blocked (waiting
 * on you), done (finished, unseen), crashed (died, unnoticed) -- and each must
 * stop being shown once seen, or the badge outlives the thing it reported.
 *
 * `working` is deliberately absent, and this was a real bug: 50 of 84 turns on
 * one agent were cleared within a minute of starting, several within seconds,
 * because switching back to its pane wiped its state. `working` is not a
 * request for attention -- it is the agent saying what it is doing, and looking
 * at it does not make it stop. Overwriting it also breaks the rule that facts
 * only the author can know are authored by the author: only the agent knows
 * whether it is still working.
 *
 * The damage was out of proportion to the mistake because `working` is asserted
 * once, at the start of a turn. Cleared mid-turn, the agent read idle until its
 * NEXT turn began -- minutes, for a long turn.
 */
const CLEARABLE = new Set(["blocked", "done", "crashed"]);

/**
 * Does any OTHER pane in this window own an agent?
 *
 * Read-only, and best effort: if tmux or the database cannot answer we say yes,
 * which leaves the badge alone. Wrongly keeping a badge is recoverable by
 * focusing the agent's own pane; wrongly clearing one loses the signal.
 */
function windowHasAgent(
  window: string,
  focused: string,
  hostId: string | undefined,
  mux: Mux,
  store: Store | undefined,
): boolean {
  // No identity means this node has authored nothing, so no sibling can own an
  // agent and there is nothing to protect. Returning true here blocked the
  // orphan-badge clear on a node that had murmur installed but never ran init.
  if (!hostId) return false;
  const siblings = mux.panesInWindow(window).filter((candidate) => candidate !== focused);
  // No siblings means nothing to protect. Checked before opening the database
  // so a node with no events yet still clears an orphan badge: treating a
  // missing database as "a sibling might own an agent" left every stale badge
  // in place on a fresh install.
  if (siblings.length === 0) return false;
  // No database yet: nothing is recorded, so no sibling owns an agent.
  if (!store) return false;
  try {
    for (const sibling of siblings) {
      const latest = store.latestForAgent(hostId, `${hostId}:${sibling}`);
      if (latest && latest.state !== "cleared") return true;
    }
    return false;
  } catch {
    return true;
  }
}

export function clearPane(pane: string, mux: Mux = tmux): void {
  let store: Store | undefined;
  try {
    if (!pane) return;

    // The badge is a tmux window option, not murmur state, so clearing it never
    // needs murmur to know anything. Resolve the window up front: an
    // uninitialised node or a missing database must still clear rather than
    // abort the hook.
    const window = mux.windowForPane(pane);
    const identity = loadIdentity();

    let owner: OwnedPane | undefined;
    if (identity) {
      try {
        store = openStore();
        owner =
          (store.latestForAgent(identity.host_id, `${identity.host_id}:${pane}`) as
            | OwnedPane
            | undefined) ?? undefined;
      } catch {
        // No database yet. Nothing is owned; the badge still clears below.
      }
    }

    // A pane murmur has no event for can still carry a badge: an orphan from
    // the agent-attention era, or a window murmur never recorded. Left alone it
    // sits in the status bar and the tms picker forever, because nothing else
    // will ever clear it.
    //
    // But only when no SIBLING pane owns an agent. The badge is a window
    // option while "the user looked" is only true of one pane, so clearing on
    // any pane in the window let a shell pane wipe the agent's badge next to
    // it -- which is the exact case --pane exists to distinguish.
    if (!owner) {
      // No store means no database, so no sibling can own an agent and the
      // orphan badge must still clear. Gating this on `store` left every stale
      // badge in place on a fresh install -- which is what the comment above
      // was already warning about.
      if (window && !windowHasAgent(window, pane, identity?.host_id, mux, store)) {
        mux.setState(window, null);
      }
      return;
    }
    // Already cleared in the log, but the badge may still be set: the two can
    // disagree when a `cleared` event was written by a path that did not touch
    // tmux, and nothing else reconciles them. Clear the option and return
    // without appending a second, redundant `cleared` event.
    if (owner.state === "cleared") {
      mux.setState(owner.window, null);
      return;
    }

    // Not an attention request, so focus has nothing to acknowledge. Leave the
    // event log AND the badge alone: a `working` badge is legitimately set by
    // the agent, and an unrecognised state from a newer node is not something a
    // focus hook should overwrite. CLEARABLE is the single gate -- an earlier
    // version also had a `working` early return, so adding `working` to this
    // set silently did nothing.
    if (!CLEARABLE.has(owner.state)) return;

    // `owner` came from this store, so it is open; the check is for the type.
    try {
      store?.append({
        agent_id: owner.agent_id,
        session: owner.session,
        window: owner.window,
        pane: owner.pane,
        // Carry the names forward: a `cleared` row that drops them makes the
        // agent's last event nameless, which is what left "@75" in the picker.
        session_name: owner.session_name,
        window_name: owner.window_name,
        agent_name: owner.agent_name,
        pi_session: owner.pi_session,
        workstream: owner.workstream,
        role: owner.role,
        cli: owner.cli,
        driver: owner.driver,
        kind: "state",
        state: "cleared",
        message: "",
        pid: null,
        synthetic: false,
        reason: "",
        extra: {},
      });
    } catch {
      // An append that fails must not stop the badge clearing below: the badge
      // is tmux state, and leaving it set is the visible failure.
    }
    mux.setState(owner.window, null);
  } catch {
    // Focus hooks run inside the tmux server: they must always be silent and total.
  } finally {
    // One handle for the whole hook, closed once. Two opens raced each other on
    // the same WAL for no benefit.
    try {
      store?.close();
    } catch {
      // Silent and total.
    }
  }
}

export function registerClear(program: Command): void {
  program
    .command("clear")
    .description("Clear attention for the agent in a pane")
    .option("--pane <pane-id>", "focused tmux pane id")
    .action((options: { pane?: string }) => clearPane(options.pane ?? ""));
}
