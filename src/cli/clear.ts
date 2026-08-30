import type { Command } from "commander";
import { asPaneId, type WindowId } from "../ids.js";
import { type Mux, tmux } from "../mux.js";
import { openStore, type Store } from "../store.js";
import { RENDER_PRIORITY, type RenderState, renderState } from "../view.js";

/**
 * Does any OTHER pane in this window still want attention?
 *
 * The badge is a WINDOW option while "the user looked" is only true of one pane,
 * so a window holding an agent and a shell must not lose the badge when you
 * focus the shell.
 *
 * The question is asked of ATTENTION only: a busy agent next door is not a
 * reason to keep an attention badge lit.
 *
 * Fails safe by keeping the badge: if tmux or the store cannot answer we say
 * yes. Wrongly keeping a badge is recoverable by focusing the pane; wrongly
 * clearing one loses the signal.
 */
function windowBadge(window: WindowId, mux: Mux, store: Store): RenderState | null {
  const panes = new Set(mux.panesInWindow(window));
  const states = store
    .localPanes()
    .filter((pane) => panes.has(pane.pane))
    .map((pane) =>
      renderState({
        activity: pane.agent?.activity ?? null,
        attention: pane.attention.map((entry) => entry.kind),
      }),
    );
  return RENDER_PRIORITY.find((state) => state !== "idle" && states.includes(state)) ?? null;
}

/**
 * Acknowledge every attention request on one pane, and clear its window badge.
 *
 * That is the whole write path. There is no state focus must refuse to clear,
 * because attention is the only thing focus can address: `acknowledgePane` is a
 * single `DELETE FROM attention WHERE pane = ?` and cannot touch an agent's
 * activity, its identity or its owner metadata. A focus hook has nothing to
 * overwrite a running agent with.
 *
 * Best effort, silent and total: this runs inside the tmux server.
 */
export function clearPane(raw: string, mux: Mux = tmux): void {
  let store: Store | undefined;
  try {
    if (!raw) return;
    // argv is the boundary: a pane id arrives as a bare string from the tmux
    // hook that invoked us.
    const pane = asPaneId(raw);
    // The badge is a tmux window option, not murmur state, so resolving it never
    // needs murmur to know anything. A pane murmur has never seen can still
    // carry an orphan badge that nothing else will ever clear.
    const window = mux.windowForPane(pane);

    try {
      store = openStore();
      store.acknowledgePane(pane);
    } catch {
      // No database, or an unwritable one. The badge still clears below, which
      // is the visible half.
    }

    if (!window) return;
    // @agent_state is a derived, window-scoped projection. Recompute it after
    // deleting this pane's attention: blindly clearing the option made a live
    // running agent display as idle even though its agent row was untouched.
    try {
      mux.setWindowBadge(window, store ? windowBadge(window, mux, store) : null);
    } catch {
      // If the projection cannot be read, leave the existing badge alone. A
      // stale badge is recoverable; erasing a real signal is not.
    }
  } catch {
    // Focus hooks run inside the tmux server: they must always be silent and
    // total.
  } finally {
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
    .description("Acknowledge attention for a pane")
    .option("--pane <pane-id>", "focused tmux pane id")
    .action((options: { pane?: string }) => clearPane(options.pane ?? ""));
}
